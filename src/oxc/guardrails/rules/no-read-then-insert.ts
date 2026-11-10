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
  receivers: ReadonlySet<string>;
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

/** A callback that runs while its caller waits: handed to `map`, `then` or the like, or to a call whose result the caller uses. A route handler registered by a bare `app.post(...)` statement runs later. */
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
    call.parent?.type !== "ExpressionStatement"
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
      (param) =>
        (param.type === "Identifier" && param.name === name) ||
        (param.type === "AssignmentPattern" &&
          param.left.type === "Identifier" &&
          param.left.name === name),
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
  testRanges: Range[];
  branchRanges: Range[];
  text: (node: ESTree.Node) => string;
}

/** `model.get` and `model.insert` touch one table, and so do `model.get` and `model.table.insert`, but not `db.table("a")` and `db.table("b")`. */
function sameTable(read: Read, insert: Insert): boolean {
  return (
    read.receivers.has(insert.receiver) || insert.receivers.has(read.receiver)
  );
}

/** Whether `range` reads the table back or recognises a duplicate. */
function checksTheLoss(facts: Facts, range: Range, insert: Insert): boolean {
  return (
    facts.reads.some(
      (read) => contains(range, read.range) && sameTable(read, insert),
    ) || facts.duplicateChecks.some((check) => contains(range, check))
  );
}

function recovers(facts: Facts, handler: ESTree.Node, insert: Insert): boolean {
  if (
    handler.type !== "BlockStatement" &&
    handler.type !== "ArrowFunctionExpression" &&
    handler.type !== "FunctionExpression"
  )
    return DUPLICATE_CHECK.test(facts.text(handler));
  const range = handler.range;
  const throws = facts.throwRanges.filter((thrown) => contains(range, thrown));
  if (throws.length === 0) return true;
  if (
    facts.testRanges.some(
      (test) => contains(range, test) && checksTheLoss(facts, test, insert),
    )
  )
    return true;
  return (
    checksTheLoss(facts, range, insert) &&
    throws.every((thrown) =>
      facts.branchRanges.some(
        (branch) => contains(range, branch) && contains(branch, thrown),
      ),
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

function isGuarded(facts: Facts, insert: Insert, scope: Scope): boolean {
  let child: ESTree.Node = insert.call;
  let parent: ESTree.Node | null = child.parent;
  while (parent !== null && child !== scope) {
    if (insert.root !== null && isScope(child) && declares(child, insert.root))
      return true;
    if (isHandedToHelper(facts, insert, child, parent)) return true;
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
      !isGuarded(facts, insert, read.scope),
  );
}

/** Writing a row that a startup read found missing races every other replica that read the same. A catch that rethrows nothing, or rethrows only under a condition after it reads the row back or recognises a duplicate, tolerates the lost race, and so does an upsert or a helper handed the table. */
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
      testRanges: [],
      branchRanges: [],
      text: (node) => context.sourceCode.getText(node),
    };
    const { reads, duplicateChecks, throwRanges, testRanges, branchRanges } =
      facts;

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
        testRanges.length = 0;
        branchRanges.length = 0;
      },
      IfStatement(node) {
        testRanges.push(node.test.range);
        branchRanges.push(node.consequent.range);
        if (node.alternate !== null) branchRanges.push(node.alternate.range);
      },
      ConditionalExpression(node) {
        testRanges.push(node.test.range);
        branchRanges.push(node.consequent.range, node.alternate.range);
      },
      SwitchCase(node) {
        if (node.test !== null) testRanges.push(node.test.range);
        branchRanges.push(node.range);
      },
      ThrowStatement(node) {
        throwRanges.push(node.range);
      },
      Identifier(node) {
        if (DUPLICATE_CHECK.test(node.name)) duplicateChecks.push(node.range);
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
            receivers: receiverChain(insert.object),
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
