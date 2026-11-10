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
const DUPLICATE_NAME = /duplicate/iu;

type Range = readonly [number, number];
type Scope = ESTree.Program | ESTree.Function | ESTree.ArrowFunctionExpression;

interface Read {
  range: Range;
  scope: Scope;
  receivers: ReadonlySet<string>;
}

interface Insert {
  call: ESTree.CallExpression;
  callee: ESTree.MemberExpression;
  receiver: string;
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

function calledMember(
  node: ESTree.CallExpression,
  methods: ReadonlySet<string>,
): ESTree.MemberExpression | null {
  if (node.callee.type !== "MemberExpression") return null;
  const name = memberName(node.callee);
  return name !== null && methods.has(name) ? node.callee : null;
}

function isUpsert(node: ESTree.CallExpression): boolean {
  return node.arguments.some(
    (argument) =>
      argument.type === "ObjectExpression" &&
      argument.properties.some(
        (property) =>
          property.type === "Property" &&
          !property.computed &&
          property.key.type === "Identifier" &&
          property.key.name === "conflict" &&
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
  duplicateNames: Range[];
  throwRanges: Range[];
  text: (node: ESTree.Node) => string;
}

function recovers(facts: Facts, body: ESTree.Node, receiver: string): boolean {
  const range = body.range;
  return (
    !facts.throwRanges.some((thrown) => contains(range, thrown)) ||
    facts.reads.some(
      (read) => contains(range, read.range) && read.receivers.has(receiver),
    ) ||
    facts.duplicateNames.some((name) => contains(range, name))
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
    child === insert.call &&
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
    if (isHandedToHelper(facts, insert, child, parent)) return true;
    const recovery = recoveryOf(insert, child, parent);
    if (recovery !== null && recovers(facts, recovery, insert.receiver))
      return true;
    child = parent;
    parent = child.parent;
  }
  return false;
}

function isRaced(facts: Facts, insert: Insert): boolean {
  const start = insert.call.range[0];
  return facts.reads.some(
    (read) =>
      read.receivers.has(insert.receiver) &&
      read.range[1] <= start &&
      contains(read.scope.range, insert.call.range) &&
      !isGuarded(facts, insert, read.scope),
  );
}

/** Writing a row that a startup read found missing races every other replica that read the same. A catch that rethrows nothing, reads the row back or checks for a duplicate tolerates the lost race, and so does an upsert or a helper handed the table. */
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
      duplicateNames: [],
      throwRanges: [],
      text: (node) => context.sourceCode.getText(node),
    };
    const { reads, duplicateNames, throwRanges } = facts;

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
        duplicateNames.length = 0;
        throwRanges.length = 0;
      },
      ThrowStatement(node) {
        throwRanges.push(node.range);
      },
      Identifier(node) {
        if (DUPLICATE_NAME.test(node.name)) duplicateNames.push(node.range);
      },
      CallExpression(node) {
        const read = calledMember(node, READ_METHODS);
        const scope = enclosingScope(node);
        if (read !== null && scope !== null) {
          reads.push({
            range: node.range,
            scope,
            receivers: receiverChain(read.object),
          });
        }
        const insert = calledMember(node, INSERT_METHODS);
        if (insert !== null && !isUpsert(node)) {
          inserts.push({
            call: node,
            callee: insert,
            receiver: facts.text(insert.object),
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
