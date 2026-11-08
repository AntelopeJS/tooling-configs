import type { ESTree, SourceCode } from "@oxlint/plugins";
import { isHasOwnPropertyCall } from "./key-provenance.ts";
import { callName } from "./shared.ts";

/** The table and key a read names, as source text. */
interface OwnKey {
  table: string;
  key: string;
  source: SourceCode;
}

const HAS_OWN_CALLS = new Set(["Object.hasOwn", "hasOwnProperty.call"]);
const EXITS = new Set([
  "BreakStatement",
  "ContinueStatement",
  "ReturnStatement",
  "ThrowStatement",
]);

function checksOwnKey(node: ESTree.CallExpression, read: OwnKey): boolean {
  const [first, second] = node.arguments;
  if (first === undefined) return false;
  const text = (argument: ESTree.Node): string => read.source.getText(argument);
  if (
    HAS_OWN_CALLS.has(callName(node.callee) ?? "") ||
    isHasOwnPropertyCall(node.callee)
  )
    return (
      second !== undefined &&
      text(first) === read.table &&
      text(second) === read.key
    );
  const callee = node.callee;
  return (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier" &&
    callee.property.name === "hasOwnProperty" &&
    text(callee.object) === read.table &&
    text(first) === read.key
  );
}

function holdsWhenTrue(node: ESTree.Node, read: OwnKey): boolean {
  if (node.type === "ParenthesizedExpression")
    return holdsWhenTrue(node.expression, read);
  if (node.type === "CallExpression") return checksOwnKey(node, read);
  if (node.type === "UnaryExpression")
    return node.operator === "!" && holdsWhenFalse(node.argument, read);
  return (
    node.type === "LogicalExpression" &&
    node.operator === "&&" &&
    (holdsWhenTrue(node.left, read) || holdsWhenTrue(node.right, read))
  );
}

function holdsWhenFalse(node: ESTree.Node, read: OwnKey): boolean {
  if (node.type === "ParenthesizedExpression")
    return holdsWhenFalse(node.expression, read);
  if (node.type === "UnaryExpression")
    return node.operator === "!" && holdsWhenTrue(node.argument, read);
  return (
    node.type === "LogicalExpression" &&
    node.operator === "||" &&
    (holdsWhenFalse(node.left, read) || holdsWhenFalse(node.right, read))
  );
}

function exits(statement: ESTree.Statement): boolean {
  if (statement.type === "BlockStatement") {
    const last = statement.body.at(-1);
    return last !== undefined && exits(last);
  }
  return EXITS.has(statement.type);
}

function isEarlyExit(statement: ESTree.Node, read: OwnKey): boolean {
  return (
    statement.type === "IfStatement" &&
    statement.alternate === null &&
    exits(statement.consequent) &&
    holdsWhenFalse(statement.test, read)
  );
}

function statementsOf(node: ESTree.Node): readonly ESTree.Node[] | null {
  if (
    node.type === "BlockStatement" ||
    node.type === "Program" ||
    node.type === "StaticBlock"
  )
    return node.body;
  return node.type === "SwitchCase" ? node.consequent : null;
}

function guardsChild(
  parent: ESTree.Node,
  child: ESTree.Node,
  read: OwnKey,
): boolean {
  if (
    parent.type === "ConditionalExpression" ||
    parent.type === "IfStatement"
  ) {
    if (child === parent.consequent) return holdsWhenTrue(parent.test, read);
    return child === parent.alternate && holdsWhenFalse(parent.test, read);
  }
  if (parent.type === "LogicalExpression" && child === parent.right)
    return parent.operator === "&&"
      ? holdsWhenTrue(parent.left, read)
      : parent.operator === "||" && holdsWhenFalse(parent.left, read);
  const statements = statementsOf(parent);
  if (statements === null) return false;
  const index = statements.indexOf(child);
  return statements
    .slice(0, Math.max(index, 0))
    .some((statement) => isEarlyExit(statement, read));
}

/**
 * Whether an own-key check of `table` and `key` (`Object.hasOwn`, `hasOwnProperty.call`,
 * `table.hasOwnProperty`) guards `node`: it holds in the branch of a conditional, `if` or `&&`/`||`
 * that holds `node`, or an earlier `if` exits the block when it fails.
 */
export function isOwnKeyGuarded(
  node: ESTree.Node,
  table: string,
  key: string,
  source: SourceCode,
): boolean {
  const read = { table, key, source };
  let child = node;
  let parent: ESTree.Node | null = node.parent;
  while (parent !== null) {
    if (guardsChild(parent, child, read)) return true;
    child = parent;
    parent = parent.parent;
  }
  return false;
}
