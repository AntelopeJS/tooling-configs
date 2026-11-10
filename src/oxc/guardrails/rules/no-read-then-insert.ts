import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";
import { memberName } from "../shared.ts";

const READ_METHODS = new Set([
  "get",
  "getBy",
  "getAll",
  "count",
  "find",
  "findOne",
]);
const INSERT_METHODS = new Set(["insert", "insertOne", "insertMany"]);
const INLINE_CALLBACK_METHODS = new Set([
  "map",
  "flatMap",
  "forEach",
  "filter",
  "reduce",
  "some",
  "every",
  "then",
  "catch",
  "finally",
]);
const DUPLICATE_CHECK =
  /duplicate|unique|conflict|E11000|^11000$|23505|ER_DUP_ENTRY/iu;

type Range = readonly [number, number];
type Scope = ESTree.Program | ESTree.Function | ESTree.ArrowFunctionExpression;

interface Read {
  range: Range;
  scope: Scope;
  receiver: string;
  receivers: ReadonlySet<string>;
}

interface Insert {
  call: ESTree.CallExpression;
  scope: Scope;
  callee: ESTree.MemberExpression;
  receiver: string;
  root: string | null;
}

function contains(outer: Range, inner: Range): boolean {
  return outer[0] <= inner[0] && inner[1] <= outer[1];
}

function isScope(node: ESTree.Node): node is Scope {
  return (
    node.type === "Program" ||
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

function enclosingScope(node: ESTree.Node): Scope | null {
  let current = node.parent;
  while (current !== null) {
    if (isScope(current)) return current;
    current = current.parent;
  }
  return null;
}

/** A callback that runs while its caller waits: handed to `map`, `then` or the like, or to a call the caller awaits. A handler registered by `app.post(...)` or wrapped by `export const POST = withAuth(...)` runs later, on its own. */
function isInlineCallback(scope: Scope): boolean {
  const call = scope.parent;
  if (
    scope.type === "Program" ||
    scope.type === "FunctionDeclaration" ||
    call?.type !== "CallExpression" ||
    !call.arguments.some((argument) => argument === scope)
  )
    return false;
  const method =
    call.callee.type === "MemberExpression" ? memberName(call.callee) : null;
  return (
    (method !== null && INLINE_CALLBACK_METHODS.has(method)) ||
    call.parent?.type === "AwaitExpression"
  );
}

/** The function a read or an insert runs in, seen through inline callbacks such as `withRetry(() => model.getAll())` or `rows.map((row) => model.insert(row))`. */
function runningScope(node: ESTree.Node): Scope | null {
  let scope = enclosingScope(node);
  while (scope !== null && isInlineCallback(scope))
    scope = enclosingScope(scope);
  return scope;
}

function chainsFrom(node: ESTree.Node, call: ESTree.CallExpression): boolean {
  let current: ESTree.Node = node;
  while (current !== call) {
    if (current.type === "CallExpression") current = current.callee;
    else if (current.type === "MemberExpression") current = current.object;
    else return false;
  }
  return true;
}

function rootName(node: ESTree.Node): string | null {
  let current: ESTree.Node = node;
  while (
    current.type === "MemberExpression" ||
    current.type === "CallExpression"
  )
    current =
      current.type === "MemberExpression" ? current.object : current.callee;
  return current.type === "Identifier" ? current.name : null;
}

function declares(scope: Scope, name: string): boolean {
  return (
    scope.type !== "Program" &&
    scope.params.some(
      (param) => param.type === "Identifier" && param.name === name,
    )
  );
}

function calledMember(
  node: ESTree.CallExpression,
  methods: ReadonlySet<string>,
): ESTree.MemberExpression | null {
  if (node.callee.type !== "MemberExpression") return null;
  const name = memberName(node.callee);
  return name !== null && methods.has(name) ? node.callee : null;
}

function isUpsert(node: ESTree.CallExpression): boolean {
  return node.arguments
    .slice(1)
    .some(
      (argument) =>
        argument.type === "ObjectExpression" &&
        argument.properties.some(
          (property) =>
            property.type === "Property" &&
            !property.computed &&
            ((property.key.type === "Identifier" &&
              property.key.name === "conflict") ||
              (property.key.type === "Literal" &&
                property.key.value === "conflict")) &&
            !(
              property.value.type === "Literal" &&
              property.value.value === "error"
            ),
        ),
    );
}

/** What one file's traversal collected, read once it ends. */
interface Facts {
  reads: Read[];
  duplicateChecks: Range[];
  throwRanges: Range[];
  throwBlocks: ESTree.Node[];
  returnRanges: Range[];
  testRanges: Range[];
  text: (node: ESTree.Node) => string;
}

/** `model.get` and `model.insert` touch one table, and so do `model.get` and the model's raw `model.table.insert`, but not `db.table("a")` and `db.table("b")`, nor `this.get` and `this.audit.insert`. */
function sameTable(read: Read, insert: Insert): boolean {
  return (
    read.receivers.has(insert.receiver) ||
    insert.receiver === `${read.receiver}.table`
  );
}

/** A catch that returns, or keeps every `throw` inside a branch, can finish without rethrowing. */
function canFinish(facts: Facts, handler: ESTree.Node): boolean {
  const block =
    handler.type === "BlockStatement"
      ? handler
      : (handler.type === "ArrowFunctionExpression" ||
            handler.type === "FunctionExpression") &&
          handler.body?.type === "BlockStatement"
        ? handler.body
        : null;
  return (
    facts.returnRanges.some((returned) => contains(handler.range, returned)) ||
    !facts.throwBlocks.some((thrownIn) => thrownIn === block)
  );
}

/** A catch tolerates the lost race when it rethrows nothing, or when it can finish without rethrowing and either reads the table back or recognises a duplicate in a condition. */
function recovers(facts: Facts, handler: ESTree.Node, insert: Insert): boolean {
  if (
    handler.type !== "BlockStatement" &&
    handler.type !== "ArrowFunctionExpression" &&
    handler.type !== "FunctionExpression"
  )
    return DUPLICATE_CHECK.test(facts.text(handler));
  const range = handler.range;
  if (!facts.throwRanges.some((thrown) => contains(range, thrown))) return true;
  if (!canFinish(facts, handler)) return false;
  const tests = facts.testRanges.filter((test) => contains(range, test));
  const readsBack = facts.reads.some(
    (read) => contains(range, read.range) && sameTable(read, insert),
  );
  return (
    readsBack ||
    tests.some((test) =>
      facts.duplicateChecks.some((check) => contains(test, check)),
    )
  );
}

function isHandedToHelper(
  facts: Facts,
  insert: Insert,
  child: ESTree.Node,
  parent: ESTree.Node,
): boolean {
  return (
    (child.type === "ArrowFunctionExpression" ||
      child.type === "FunctionExpression") &&
    parent.type === "CallExpression" &&
    parent.arguments.some(
      (argument) =>
        argument !== child && facts.text(argument) === insert.receiver,
    )
  );
}

function recoveryOf(
  insert: Insert,
  child: ESTree.Node,
  parent: ESTree.Node,
): ESTree.Node | null {
  if (parent.type === "TryStatement" && parent.block === child)
    return parent.handler?.body ?? null;
  if (
    parent.type === "MemberExpression" &&
    parent.object === child &&
    chainsFrom(child, insert.call) &&
    memberName(parent) === "catch" &&
    parent.parent?.type === "CallExpression" &&
    parent.parent.callee === parent
  )
    return parent.parent.arguments[0] ?? null;
  return null;
}

function isGuarded(facts: Facts, insert: Insert, read: Read): boolean {
  let child: ESTree.Node = insert.call;
  let parent: ESTree.Node | null = child.parent;
  while (parent !== null && child !== read.scope) {
    const between = !contains(child.range, read.range);
    if (
      between &&
      insert.root !== null &&
      isScope(child) &&
      declares(child, insert.root)
    )
      return true;
    if (between && isHandedToHelper(facts, insert, child, parent)) return true;
    const recovery = recoveryOf(insert, child, parent);
    if (recovery !== null && recovers(facts, recovery, insert)) return true;
    child = parent;
    parent = child.parent;
  }
  return false;
}

function isRaced(facts: Facts, insert: Insert): boolean {
  const start = insert.call.range[0];
  return facts.reads.some(
    (read) =>
      sameTable(read, insert) &&
      read.range[1] <= start &&
      read.scope === insert.scope &&
      !isGuarded(facts, insert, read),
  );
}

/** Writing a row that a startup read found missing races every other replica that read the same. A catch that rethrows nothing, recognises a duplicate in a condition, or reads the row back and branches, tolerates the lost race, and so does an upsert or a helper handed the table. */
export const noReadThenInsertRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Reject an insert that follows a read of the same table unless a catch tolerates losing it.",
    },
    messages: {
      readThenInsert:
        '`{{receiver}}` is read and then inserted into. Two replicas that start on an empty table both read nothing and both insert, so one writes a duplicate row or fails on the key. Key the row by a stable id, wrap the insert in try/catch, read the row back in the catch, and rethrow only when it is still missing, or upsert with `insert(row, { conflict: "update" })`.',
    },
  },
  createOnce(context) {
    const inserts: Insert[] = [];
    const facts: Facts = {
      reads: [],
      duplicateChecks: [],
      throwRanges: [],
      throwBlocks: [],
      returnRanges: [],
      testRanges: [],
      text: (node) => context.sourceCode.getText(node),
    };
    const { reads, duplicateChecks, throwRanges, testRanges } = facts;

    function receiverChain(start: ESTree.Node): Set<string> {
      const texts = new Set<string>();
      let current: ESTree.Node | null = start;
      while (current !== null) {
        texts.add(facts.text(current));
        if (current.type === "CallExpression") current = current.callee;
        else if (current.type === "MemberExpression") current = current.object;
        else current = null;
      }
      return texts;
    }

    return {
      before() {
        reads.length = 0;
        inserts.length = 0;
        duplicateChecks.length = 0;
        throwRanges.length = 0;
        facts.throwBlocks.length = 0;
        facts.returnRanges.length = 0;
        testRanges.length = 0;
      },
      IfStatement(node) {
        testRanges.push(node.test.range);
      },
      ConditionalExpression(node) {
        testRanges.push(node.test.range);
      },
      SwitchCase(node) {
        if (node.test !== null) testRanges.push(node.test.range);
      },
      ThrowStatement(node) {
        throwRanges.push(node.range);
        if (node.parent !== null) facts.throwBlocks.push(node.parent);
      },
      ReturnStatement(node) {
        facts.returnRanges.push(node.range);
      },
      Identifier(node) {
        if (DUPLICATE_CHECK.test(node.name)) duplicateChecks.push(node.range);
      },
      TemplateLiteral(node) {
        if (node.quasis.some((quasi) => DUPLICATE_CHECK.test(quasi.value.raw)))
          duplicateChecks.push(node.range);
      },
      Literal(node) {
        if (DUPLICATE_CHECK.test(String(node.value)))
          duplicateChecks.push(node.range);
      },
      CallExpression(node) {
        if (facts.text(node.callee) === "Promise.reject")
          throwRanges.push(node.range);
        const read = calledMember(node, READ_METHODS);
        const scope = runningScope(node);
        if (read !== null && scope !== null) {
          reads.push({
            range: node.range,
            scope,
            receiver: facts.text(read.object),
            receivers: receiverChain(read.object),
          });
        }
        const insert = calledMember(node, INSERT_METHODS);
        if (insert !== null && scope !== null && !isUpsert(node)) {
          inserts.push({
            call: node,
            scope,
            callee: insert,
            receiver: facts.text(insert.object),
            root: rootName(insert.object),
          });
        }
      },
      "Program:exit"() {
        for (const insert of inserts) {
          if (isRaced(facts, insert)) {
            context.report({
              node: insert.callee,
              messageId: "readThenInsert",
              data: { receiver: insert.receiver },
            });
          }
        }
      },
    };
  },
});
