import type { ESTree, SourceCode } from "@oxlint/plugins";
import { isHasOwnPropertyCall } from "./key-provenance.ts";
import { resolveVariable } from "./local-types.ts";
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

const EQUALITY = new Set(["==", "==="]);
const INEQUALITY = new Set(["!=", "!=="]);
const MAX_DEPTH = 8;

/** The initializer of a `const` the identifier names, such as `has` in `const has = Object.hasOwn(t, k)`. */
function constValue(
  node: ESTree.Node & { name: string },
  read: OwnKey,
): ESTree.Expression | null {
  const [definition] = resolveVariable(read.source, node)?.defs ?? [];
  if (
    definition?.type !== "Variable" ||
    definition.parent?.type !== "VariableDeclaration" ||
    definition.parent.kind !== "const" ||
    definition.node.type !== "VariableDeclarator"
  )
    return null;
  return definition.node.init;
}

/** `x === true`, `x !== false` and their mirrors: the outcome `x` has when the comparison has `outcome`. */
function comparedOutcome(
  node: { operator: string; left: ESTree.Node; right: ESTree.Node },
  outcome: boolean,
): { operand: ESTree.Node; outcome: boolean } | null {
  const equal = EQUALITY.has(node.operator);
  if (!equal && !INEQUALITY.has(node.operator)) return null;
  const [literal, operand] =
    node.right.type === "Literal"
      ? [node.right, node.left]
      : [node.left, node.right];
  if (literal.type !== "Literal") return null;
  const value = literal.value;
  if (value !== true && value !== false) return null;
  return { operand, outcome: (outcome === equal) === value };
}

/** Whether the own-key check holds whenever `node` evaluates to `outcome`. */
function holds(
  node: ESTree.Node,
  outcome: boolean,
  read: OwnKey,
  depth = 0,
): boolean {
  if (depth > MAX_DEPTH) return false;
  switch (node.type) {
    case "ParenthesizedExpression":
      return holds(node.expression, outcome, read, depth);
    case "CallExpression":
      return outcome && checksOwnKey(node, read);
    case "Identifier": {
      const value = constValue(node, read);
      return value !== null && holds(value, outcome, read, depth + 1);
    }
    case "UnaryExpression":
      return (
        node.operator === "!" && holds(node.argument, !outcome, read, depth)
      );
    case "BinaryExpression": {
      const compared = comparedOutcome(node, outcome);
      return (
        compared !== null &&
        holds(compared.operand, compared.outcome, read, depth)
      );
    }
    case "LogicalExpression":
      return (
        node.operator === (outcome ? "&&" : "||") &&
        (holds(node.left, outcome, read, depth) ||
          holds(node.right, outcome, read, depth))
      );
    default:
      return false;
  }
}

function exits(statement: ESTree.Statement): boolean {
  if (statement.type === "BlockStatement") {
    const last = statement.body.at(-1);
    return last !== undefined && exits(last);
  }
  if (statement.type === "IfStatement")
    return (
      statement.alternate !== null &&
      exits(statement.consequent) &&
      exits(statement.alternate)
    );
  return EXITS.has(statement.type);
}

/** An `if` that leaves the block on the branch where the check fails, so later statements run only when it holds. */
function isEarlyExit(statement: ESTree.Node, read: OwnKey): boolean {
  if (statement.type !== "IfStatement") return false;
  if (exits(statement.consequent) && holds(statement.test, false, read))
    return true;
  return (
    statement.alternate !== null &&
    exits(statement.alternate) &&
    holds(statement.test, true, read)
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
    if (child === parent.consequent) return holds(parent.test, true, read);
    return child === parent.alternate && holds(parent.test, false, read);
  }
  if (parent.type === "LogicalExpression" && child === parent.right)
    return (
      (parent.operator === "&&" || parent.operator === "||") &&
      holds(parent.left, parent.operator === "&&", read)
    );
  if (parent.type === "WhileStatement")
    return child === parent.body && holds(parent.test, true, read);
  if (parent.type === "ForStatement")
    return (
      (child === parent.body || child === parent.update) &&
      parent.test !== null &&
      holds(parent.test, true, read)
    );
  const statements = statementsOf(parent);
  if (statements === null) return false;
  const index = statements.indexOf(child);
  return statements
    .slice(0, Math.max(index, 0))
    .some((statement) => isEarlyExit(statement, read));
}

/**
 * Whether an own-key check of `table` and `key` (`Object.hasOwn`, `hasOwnProperty.call`,
 * `table.hasOwnProperty`, directly, negated, compared with a boolean or held in a `const`) guards
 * `node`: it holds in the branch of a conditional, `if`, `&&`/`||`, `while` or `for` that holds
 * `node`, or an earlier `if` leaves the block on the branch where it fails.
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
