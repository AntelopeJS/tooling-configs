import type { ESTree, SourceCode, Variable } from "@oxlint/plugins";
import { resolveVariable } from "./local-types.ts";
import { memberName } from "./shared.ts";

/** A condition that runs one branch or another: `if`, `?:`, or the right side of `&&`, `||` and `??`. */
export type Conditional =
  | ESTree.IfStatement
  | ESTree.ConditionalExpression
  | ESTree.LogicalExpression;

/** A read call and the variable its result is stored in, such as `record` in `const record = await model.findByKey(key)`. */
export interface ReadSubject {
  call: ESTree.CallExpression;
  binding: Variable | null;
}

/** What a test's outcome proves about the read: whether the test passing, or failing, means the read found nothing. */
interface Implication {
  whenTrue: boolean;
  whenFalse: boolean;
}

type Comparison = "==" | "===" | "!=" | "!==" | "<" | "<=" | ">" | ">=";

const MIRRORED: Readonly<Record<Comparison, Comparison>> = {
  "==": "==",
  "===": "===",
  "!=": "!=",
  "!==": "!==",
  "<": ">",
  "<=": ">=",
  ">": "<",
  ">=": "<=",
};
const UNKNOWN: Implication = { whenTrue: false, whenFalse: false };
const FOUND_WHEN_TRUE: Implication = { whenTrue: false, whenFalse: true };
const EMPTY_WHEN_TRUE: Implication = { whenTrue: true, whenFalse: false };

/** Whether `node` is `call`, or a call or member chained from it such as `table.get(id).run()`. */
export function chainsFrom(
  node: ESTree.Node,
  call: ESTree.CallExpression,
): boolean {
  let current: ESTree.Node = node;
  while (current !== call) {
    if (current.type === "CallExpression") current = current.callee;
    else if (current.type === "MemberExpression") current = current.object;
    else return false;
  }
  return true;
}

function unwrap(node: ESTree.Node): ESTree.Node {
  if (node.type === "AwaitExpression") return unwrap(node.argument);
  if (
    node.type === "ChainExpression" ||
    node.type === "ParenthesizedExpression" ||
    node.type === "TSAsExpression" ||
    node.type === "TSNonNullExpression"
  )
    return unwrap(node.expression);
  return node;
}

function isMethodCall(member: ESTree.MemberExpression): boolean {
  return (
    member.parent?.type === "CallExpression" && member.parent.callee === member
  );
}

/** Whether `.length` or an index such as `[0]` reads the settled result: on rows, they still tell whether the read found any. */
function isCountOrIndex(member: ESTree.MemberExpression): boolean {
  return (
    memberName(member) === "length" ||
    (member.computed &&
      member.property.type === "Literal" &&
      Number.isInteger(member.property.value))
  );
}

/** Whether `parent` passes on the read's value. Before the read settles a method call builds the query (`.limit(1).run()`, `.then(...)`); once awaited, only `.length` or an index keeps it, since a field or method of the row is other data. */
function carriesValue(
  node: ESTree.Node,
  parent: ESTree.Node,
  settled: boolean,
): boolean {
  if (parent.type === "MemberExpression")
    return (
      parent.object === node &&
      (settled ? isCountOrIndex(parent) : isMethodCall(parent))
    );
  return (
    parent.type === "AwaitExpression" ||
    parent.type === "ChainExpression" ||
    parent.type === "ParenthesizedExpression" ||
    parent.type === "TSAsExpression" ||
    parent.type === "TSNonNullExpression" ||
    (parent.type === "CallExpression" && parent.callee === node)
  );
}

/** The outermost expression that still holds a read's value, the node around it, and whether the read settled on the way through `await` or `.then(...)`. */
function readValue(call: ESTree.CallExpression) {
  let node: ESTree.Node = call;
  let parent: ESTree.Node | null = node.parent;
  let settled = false;
  while (parent !== null && carriesValue(node, parent, settled)) {
    if (
      parent.type === "AwaitExpression" ||
      (parent.type === "MemberExpression" && memberName(parent) === "then")
    )
      settled = true;
    node = parent;
    parent = node.parent;
  }
  return { node, parent, settled };
}

/** Whether a read's value is awaited, directly or through a chain such as `table.get(id).run()` or `.then(...)`: a table read is asynchronous, unlike `Map.get` or `headers.get`. */
export function isAwaitedRead(call: ESTree.CallExpression): boolean {
  return readValue(call).settled;
}

/** The variable a read's result is stored in, through `await`, `.run()` and the like: `rows` in `const rows = await table.getAll().run()`, or the first row in `const [row] = await table.getAll()` or `(await table.getAll())[0]`. */
export function readBinding(
  source: SourceCode,
  call: ESTree.CallExpression,
): Variable | null {
  const { node, parent } = readValue(call);
  if (parent?.type !== "VariableDeclarator" || parent.init !== node)
    return null;
  const target =
    parent.id.type === "ArrayPattern" ? parent.id.elements[0] : parent.id;
  if (target?.type !== "Identifier") return null;
  return (
    source
      .getDeclaredVariables(parent)
      .find((variable) => variable.name === target.name) ?? null
  );
}

function isSubject(
  source: SourceCode,
  node: ESTree.Node,
  subject: ReadSubject,
): boolean {
  const value = unwrap(node);
  if (value.type === "Identifier")
    return (
      subject.binding !== null &&
      resolveVariable(source, value) === subject.binding
    );
  return chainsFrom(value, subject.call);
}

function isCounted(
  source: SourceCode,
  node: ESTree.Node,
  subject: ReadSubject,
): boolean {
  const value = unwrap(node);
  return (
    isSubject(source, value, subject) ||
    (value.type === "MemberExpression" &&
      memberName(value) === "length" &&
      isSubject(source, value.object, subject))
  );
}

function holds(operator: Comparison, left: number, right: number): boolean {
  switch (operator) {
    case "==":
    case "===":
      return left === right;
    case "!=":
    case "!==":
      return left !== right;
    case "<":
      return left < right;
    case "<=":
      return left <= right;
    case ">":
      return left > right;
    case ">=":
      return left >= right;
  }
}

function isComparison(operator: string): operator is Comparison {
  return Object.hasOwn(MIRRORED, operator);
}

/** What `subject <operator> constant` proves: `record === undefined`, `count === 0` and `rows.length < 1` pass only when the read found nothing. */
function compared(operator: Comparison, constant: ESTree.Node): Implication {
  const nothing =
    (constant.type === "Literal" &&
      constant.value === null &&
      !("regex" in constant)) ||
    (constant.type === "Identifier" && constant.name === "undefined");
  if (nothing)
    return operator === "==" || operator === "==="
      ? EMPTY_WHEN_TRUE
      : FOUND_WHEN_TRUE;
  if (constant.type !== "Literal" || !Number.isFinite(constant.value))
    return UNKNOWN;
  const bound = Number(constant.value);
  const empty = holds(operator, 0, bound);
  if (empty === holds(operator, Number.MAX_SAFE_INTEGER, bound)) return UNKNOWN;
  return empty ? EMPTY_WHEN_TRUE : FOUND_WHEN_TRUE;
}

function implication(
  source: SourceCode,
  test: ESTree.Node,
  subject: ReadSubject,
): Implication {
  const value = unwrap(test);
  if (isCounted(source, value, subject)) return FOUND_WHEN_TRUE;
  if (value.type === "UnaryExpression" && value.operator === "!") {
    const inner = implication(source, value.argument, subject);
    return { whenTrue: inner.whenFalse, whenFalse: inner.whenTrue };
  }
  if (value.type === "LogicalExpression" && value.operator !== "??") {
    const left = implication(source, value.left, subject);
    const right = implication(source, value.right, subject);
    return value.operator === "&&"
      ? { whenTrue: left.whenTrue || right.whenTrue, whenFalse: false }
      : { whenTrue: false, whenFalse: left.whenFalse || right.whenFalse };
  }
  if (value.type !== "BinaryExpression" || !isComparison(value.operator))
    return UNKNOWN;
  if (isCounted(source, value.left, subject))
    return compared(value.operator, unwrap(value.right));
  if (isCounted(source, value.right, subject))
    return compared(MIRRORED[value.operator], unwrap(value.left));
  return UNKNOWN;
}

function within(outer: ESTree.Node | null, inner: ESTree.Node): boolean {
  return (
    outer !== null &&
    outer.range[0] <= inner.range[0] &&
    inner.range[1] <= outer.range[1]
  );
}

function lastStatement(statement: ESTree.Node | null): ESTree.Node | null {
  if (statement?.type === "BlockStatement")
    return lastStatement(statement.body.at(-1) ?? null);
  return statement;
}

function isFunction(node: ESTree.Node): boolean {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

function isLoop(node: ESTree.Node): boolean {
  return (
    node.type === "ForStatement" ||
    node.type === "ForInStatement" ||
    node.type === "ForOfStatement" ||
    node.type === "WhileStatement" ||
    node.type === "DoWhileStatement"
  );
}

/** The node an exit leaves: its function for `return` and `throw`, its loop for `continue`, its loop or switch for `break`. */
function exited(exit: ESTree.Node): ESTree.Node | null {
  const leavesFunction =
    exit.type === "ReturnStatement" || exit.type === "ThrowStatement";
  if (
    !leavesFunction &&
    exit.type !== "ContinueStatement" &&
    exit.type !== "BreakStatement"
  )
    return null;
  let current: ESTree.Node | null = exit.parent;
  while (current !== null) {
    if (isFunction(current)) return current;
    if (!leavesFunction && isLoop(current)) return current;
    if (exit.type === "BreakStatement" && current.type === "SwitchStatement")
      return current;
    current = current.parent;
  }
  return null;
}

function leaves(branch: ESTree.Node | null, site: ESTree.Node): boolean {
  const exit = lastStatement(branch);
  return exit !== null && within(exited(exit), site);
}

/** Whether a branch ends in an exit that skips `site`: the exit leaves a function or loop that holds the site, and the site follows the `if` in the block that holds it. An `else if` reaches that block only when every earlier arm exits past the site too. */
function skips(
  conditional: ESTree.IfStatement,
  branch: ESTree.Node | null,
  site: ESTree.Node,
): boolean {
  let arm: ESTree.Node = conditional;
  let block: ESTree.Node | null = conditional.parent;
  while (block?.type === "IfStatement") {
    if (block.alternate !== arm || !leaves(block.consequent, site))
      return false;
    arm = block;
    block = block.parent;
  }
  return (
    conditional.range[1] <= site.range[0] &&
    within(block, site) &&
    leaves(branch, site)
  );
}

/** Whether a conditional runs `site` only when the read found nothing: the site sits in the branch taken only then, or it follows an `if` whose branch for a found row skips it, as in `if (record) return;`. */
export function decides(
  source: SourceCode,
  subject: ReadSubject,
  conditional: Conditional,
  site: ESTree.Node,
): boolean {
  if (conditional.type === "LogicalExpression") {
    const left = implication(source, conditional.left, subject);
    const runsRight =
      conditional.operator === "&&" ? left.whenTrue : left.whenFalse;
    return runsRight && within(conditional.right, site);
  }
  const { whenTrue, whenFalse } = implication(
    source,
    conditional.test,
    subject,
  );
  if (
    (whenTrue && within(conditional.consequent, site)) ||
    (whenFalse && within(conditional.alternate, site))
  )
    return true;
  return (
    conditional.type === "IfStatement" &&
    ((whenFalse && skips(conditional, conditional.consequent, site)) ||
      (whenTrue && skips(conditional, conditional.alternate, site)))
  );
}

/** The function a plain call runs, found through the scope its name resolves in: a function declaration (the implementation of an overloaded one, whose signatures declare no function), or a variable that holds a function. A name the code reassigns is not followed. */
export function calledFunction(
  source: SourceCode,
  callee: ESTree.IdentifierReference,
): ESTree.Function | ESTree.ArrowFunctionExpression | null {
  const variable = resolveVariable(source, callee);
  if (
    variable === null ||
    variable.references.some(
      (reference) => reference.isWrite() && !reference.init,
    )
  )
    return null;
  for (const { node } of variable.defs) {
    if (node.type === "FunctionDeclaration") return node;
    if (
      node.type === "VariableDeclarator" &&
      (node.init?.type === "ArrowFunctionExpression" ||
        node.init?.type === "FunctionExpression")
    )
      return node.init;
  }
  return null;
}
