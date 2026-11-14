import { defineRule } from "@oxlint/plugins";

import type { ESTree, SourceCode } from "@oxlint/plugins";
import {
  calledFunction,
  chainsFrom,
  type Conditional,
  decides,
  isAwaitedRead,
  readBinding,
  type ReadSubject,
} from "../read-decision.ts";
import { memberName } from "../shared.ts";

const READ_METHOD =
  /^(?:get|getAll|count|find|findOne|(?:get|find)By(?:[A-Z]\w*)?)$/u;
const INSERT_METHOD = /^(?:insert|insertOne|insertMany)$/u;
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

interface Read extends ReadSubject {
  range: Range;
  scope: Scope;
  receiver: string;
  receivers: ReadonlySet<string>;
}

/** A call to a function of this file by its name, such as `createAsset(target, file)`. */
interface Site {
  call: ESTree.CallExpression;
  scope: Scope;
  name: string;
  target: Scope;
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

/** A callback that runs while its caller waits: handed to `map`, `then` or the like, or to a call whose value the caller awaits or returns. A handler registered by `app.post(...)` or wrapped by `export const POST = withAuth(...)` runs later, on its own. */
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
    (method !== null && INLINE_CALLBACK_METHODS.has(method)) || isAwaited(call)
  );
}

/** Whether the call's value reaches an `await` or a `return`, through array elements, call arguments, `?.` or a `.then` chain, or is the body of an inline arrow. */
function isAwaited(call: ESTree.CallExpression): boolean {
  let node: ESTree.Node = call;
  let parent: ESTree.Node | null = node.parent;
  while (parent !== null) {
    if (parent.type === "AwaitExpression" || parent.type === "ReturnStatement")
      return true;
    if (parent.type === "ArrowFunctionExpression" && parent.body === node)
      return isInlineCallback(parent);
    const carries =
      parent.type === "ArrayExpression" ||
      parent.type === "ChainExpression" ||
      parent.type === "SpreadElement" ||
      parent.type === "CallExpression" ||
      (parent.type === "MemberExpression" && parent.object === node);
    if (!carries) return false;
    node = parent;
    parent = node.parent;
  }
  return false;
}

/** The function a read or an insert runs in, seen through inline callbacks such as `withRetry(() => model.getAll())` or `rows.map((row) => model.insert(row))`. */
function runningScope(node: ESTree.Node): Scope | null {
  let scope = enclosingScope(node);
  while (scope !== null && isInlineCallback(scope))
    scope = enclosingScope(scope);
  return scope;
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
  methods: RegExp,
): ESTree.MemberExpression | null {
  if (node.callee.type !== "MemberExpression") return null;
  const name = memberName(node.callee);
  return name !== null && methods.test(name) ? node.callee : null;
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
  inserts: Insert[];
  duplicateChecks: Range[];
  throwRanges: Range[];
  throwBlocks: ESTree.Node[];
  exits: ESTree.Node[];
  conditionals: Conditional[];
  sites: Site[];
  readonly source: SourceCode;
  text: (node: ESTree.Node) => string;
}

/** `model.get` and `model.insert` touch one table, and so do `model.get` and the model's raw `model.table.insert`, but not `db.table("a")` and `db.table("b")`, nor `this.get` and `this.audit.insert`. */
function sameTable(read: Read, insert: Insert): boolean {
  return (
    read.receivers.has(insert.receiver) ||
    insert.receiver === `${read.receiver}.table`
  );
}

/** A catch that returns, continues or breaks in its own function without a rejection, or keeps every `throw` inside a branch, can finish without rethrowing. */
function canFinish(facts: Facts, handler: ESTree.Node): boolean {
  const own =
    handler.type === "BlockStatement" ? enclosingScope(handler) : handler;
  const block =
    handler.type === "BlockStatement"
      ? handler
      : (handler.type === "ArrowFunctionExpression" ||
            handler.type === "FunctionExpression") &&
          handler.body?.type === "BlockStatement"
        ? handler.body
        : null;
  return (
    facts.exits.some(
      (exit) =>
        contains(handler.range, exit.range) &&
        enclosingScope(exit) === own &&
        !facts.throwRanges.some((thrown) => contains(exit.range, thrown)),
    ) || !facts.throwBlocks.some((thrownIn) => thrownIn === block)
  );
}

/** A catch tolerates the lost race when it rethrows nothing, or when it can finish without rethrowing and either reads the table back or checks for a duplicate outside a `throw`. */
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
  return (
    facts.reads.some(
      (read) => contains(range, read.range) && sameTable(read, insert),
    ) ||
    facts.duplicateChecks.some(
      (check) =>
        contains(range, check) &&
        !facts.throwRanges.some((thrown) => contains(thrown, check)),
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
  site: ESTree.CallExpression,
  child: ESTree.Node,
  parent: ESTree.Node,
): ESTree.Node | null {
  if (parent.type === "TryStatement" && parent.block === child)
    return parent.handler?.body ?? null;
  if (
    parent.type === "MemberExpression" &&
    parent.object === child &&
    chainsFrom(child, site) &&
    memberName(parent) === "catch" &&
    parent.parent?.type === "CallExpression" &&
    parent.parent.callee === parent
  )
    return parent.parent.arguments[0] ?? null;
  return null;
}

/** Whether the insert is guarded on the way from `site` up to `stop`: `site` is the insert itself, or a call that reaches it. Only the insert's own function can shadow the read's receiver or hand the insert to a helper; any call on the way can recover from it. */
function isGuarded(
  facts: Facts,
  insert: Insert,
  site: ESTree.CallExpression,
  stop: Scope,
  read: Read | null,
): boolean {
  let child: ESTree.Node = site;
  let parent: ESTree.Node | null = child.parent;
  while (parent !== null && child !== stop) {
    const between =
      site === insert.call &&
      (read === null || !contains(child.range, read.range));
    if (
      between &&
      read !== null &&
      insert.root !== null &&
      isScope(child) &&
      declares(child, insert.root)
    )
      return true;
    if (between && isHandedToHelper(facts, insert, child, parent)) return true;
    const recovery = recoveryOf(site, child, parent);
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
      !isGuarded(facts, insert, insert.call, insert.scope, read),
  );
}

/** The unguarded inserts each function makes, in its own body or through the functions of this file it calls, grown until no call adds one so the order of a cycle does not matter. */
function reachedInserts(facts: Facts): Map<Scope, Set<Insert>> {
  const reached = new Map<Scope, Set<Insert>>();
  const of = (scope: Scope): Set<Insert> => {
    const known = reached.get(scope);
    if (known !== undefined) return known;
    const created = new Set<Insert>();
    reached.set(scope, created);
    return created;
  };
  for (const insert of facts.inserts)
    if (!isGuarded(facts, insert, insert.call, insert.scope, null))
      of(insert.scope).add(insert);
  let changed = true;
  while (changed) {
    changed = false;
    for (const site of facts.sites) {
      const into = of(site.scope);
      for (const insert of of(site.target)) {
        if (
          into.has(insert) ||
          isGuarded(facts, insert, site.call, site.scope, null)
        )
          continue;
        into.add(insert);
        changed = true;
      }
    }
  }
  return reached;
}

/** An insert a call makes when a read before it found nothing, as in `if (record) return; await createAsset(target)`. */
interface CalledInsert {
  insert: Insert;
  read: Read;
  site: Site;
}

function racedThroughCalls(facts: Facts): CalledInsert[] {
  const reached = reachedInserts(facts);
  return facts.reads
    .filter(({ call }) => isAwaitedRead(call))
    .flatMap((read) => {
      const conditionals = facts.conditionals.filter(
        (conditional) =>
          conditional.range[1] > read.range[0] &&
          runningScope(conditional) === read.scope,
      );
      return facts.sites
        .filter(
          (site) =>
            site.scope === read.scope &&
            read.range[1] <= site.call.range[0] &&
            conditionals.some((conditional) =>
              decides(facts.source, read, conditional, site.call),
            ),
        )
        .flatMap((site) =>
          [...(reached.get(site.target) ?? [])]
            .filter(
              (insert) =>
                !isGuarded(facts, insert, site.call, read.scope, null),
            )
            .map((insert) => ({ insert, read, site })),
        );
    });
}

function receiverChain(facts: Facts, start: ESTree.Node): Set<string> {
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

function collectCall(facts: Facts, node: ESTree.CallExpression): void {
  if (facts.text(node.callee) === "Promise.reject") {
    facts.throwRanges.push(node.range);
    const statement = node.parent;
    if (statement?.type === "ReturnStatement" && statement.parent !== null)
      facts.throwBlocks.push(statement.parent);
  }
  const scope = runningScope(node);
  if (scope === null) return;
  const target =
    node.callee.type === "Identifier"
      ? calledFunction(facts.source, node.callee)
      : null;
  if (target !== null && node.callee.type === "Identifier")
    facts.sites.push({ call: node, scope, name: node.callee.name, target });
  const read = calledMember(node, READ_METHOD);
  if (read !== null) {
    facts.reads.push({
      call: node,
      binding: readBinding(facts.source, node),
      range: node.range,
      scope,
      receiver: facts.text(read.object),
      receivers: receiverChain(facts, read.object),
    });
  }
  const insert = calledMember(node, INSERT_METHOD);
  if (insert !== null && !isUpsert(node)) {
    facts.inserts.push({
      call: node,
      scope,
      callee: insert,
      receiver: facts.text(insert.object),
      root: rootName(insert.object),
    });
  }
}

const RACE =
  'Two replicas that start on an empty table both read nothing and both insert, so one writes a duplicate row or fails on the key. Key the row by a stable id, wrap the insert in try/catch, read the row back in the catch, and rethrow only when it is still missing, or upsert with `insert(row, { conflict: "update" })`.';

/** Writing a row that a startup read found missing races every other replica that read the same, whether the insert sits in the reading function or in a function of the file it calls only when the read found nothing. A catch that rethrows nothing, recognises a duplicate in a condition, or reads the row back and branches, tolerates the lost race, and so does an upsert or a helper handed the table. */
export const noReadThenInsertRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Reject an insert that follows a read of the same table, or that a called function makes when a read found nothing, unless a catch tolerates losing it.",
    },
    messages: {
      readThenInsert: `\`{{receiver}}\` is read and then inserted into. ${RACE}`,
      readThenCalledInsert: `\`{{read}}\` found nothing, so \`{{call}}\` runs and inserts into \`{{receiver}}\`. ${RACE}`,
    },
  },
  createOnce(context) {
    const facts: Facts = {
      reads: [],
      inserts: [],
      duplicateChecks: [],
      throwRanges: [],
      throwBlocks: [],
      exits: [],
      conditionals: [],
      sites: [],
      get source() {
        return context.sourceCode;
      },
      text: (node) => context.sourceCode.getText(node),
    };
    const exit = (node: ESTree.Node) => facts.exits.push(node);
    const conditional = (node: Conditional) => facts.conditionals.push(node);

    return {
      before() {
        for (const list of [
          facts.reads,
          facts.inserts,
          facts.duplicateChecks,
          facts.throwRanges,
          facts.throwBlocks,
          facts.exits,
          facts.conditionals,
          facts.sites,
        ])
          list.length = 0;
      },
      ThrowStatement(node) {
        facts.throwRanges.push(node.range);
        if (node.parent !== null) facts.throwBlocks.push(node.parent);
      },
      ReturnStatement: exit,
      ContinueStatement: exit,
      BreakStatement: exit,
      IfStatement: conditional,
      ConditionalExpression: conditional,
      LogicalExpression: conditional,
      Identifier(node) {
        if (DUPLICATE_CHECK.test(node.name))
          facts.duplicateChecks.push(node.range);
      },
      TemplateLiteral(node) {
        if (node.quasis.some((quasi) => DUPLICATE_CHECK.test(quasi.value.raw)))
          facts.duplicateChecks.push(node.range);
      },
      Literal(node) {
        if (DUPLICATE_CHECK.test(String(node.value)))
          facts.duplicateChecks.push(node.range);
      },
      CallExpression(node) {
        collectCall(facts, node);
      },
      "Program:exit"() {
        const reported = new Set<Insert>();
        for (const insert of facts.inserts) {
          if (!isRaced(facts, insert)) continue;
          reported.add(insert);
          context.report({
            node: insert.callee,
            messageId: "readThenInsert",
            data: { receiver: insert.receiver },
          });
        }
        for (const { insert, read, site } of racedThroughCalls(facts)) {
          if (reported.has(insert)) continue;
          reported.add(insert);
          context.report({
            node: insert.callee,
            messageId: "readThenCalledInsert",
            data: {
              read: facts.text(read.call.callee),
              call: site.name,
              receiver: insert.receiver,
            },
          });
        }
      },
    };
  },
});
