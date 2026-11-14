import ts from "@typescript/typescript6";

import {
  arrayElement,
  isAnyType,
  isUnknown,
  leaks,
  takesAnything,
} from "./any-leaks.ts";

/** How a returned type holds `any`, as typescript-eslint's `discriminateAnyType` sorts it. */
type AnyKind = "any" | "any[]" | "Promise<any>" | "safe";

function anyKind(checker: ts.TypeChecker, type: ts.Type): AnyKind {
  if (isAnyType(checker, type)) return "any";
  const element = arrayElement(checker, type);
  if (element !== undefined && isAnyType(checker, element)) return "any[]";
  const parts = type.isUnionOrIntersection() ? type.types : [type];
  return parts.some((part) => {
    const awaited = checker.getAwaitedType(part);
    return awaited !== undefined && isAnyType(checker, awaited);
  })
    ? "Promise<any>"
    : "safe";
}

/** The function a returned `value` leaves. */
function ownerOf(value: ts.Expression): ts.SignatureDeclaration | undefined {
  let owner = value.parent;
  while (!ts.isFunctionLike(owner)) {
    if (ts.isSourceFile(owner)) return undefined;
    owner = owner.parent;
  }
  return owner;
}

/** The type typescript-eslint's `getContextualType` gives a function expression: the parameter's at an argument, the annotation's in an annotated declaration, the target's at the right of an assignment, and none elsewhere, as in an object literal, an array, `as`, `satisfies`, a conditional, parentheses or a return. */
function contextOf(
  checker: ts.TypeChecker,
  node: ts.ArrowFunction | ts.FunctionExpression,
): ts.Type | undefined {
  const { parent } = node;
  if (ts.isCallExpression(parent) || ts.isNewExpression(parent))
    return parent.expression === node
      ? undefined
      : checker.getContextualType(node);
  if (
    ts.isVariableDeclaration(parent) ||
    ts.isPropertyDeclaration(parent) ||
    ts.isParameter(parent)
  )
    return parent.type && checker.getTypeFromTypeNode(parent.type);
  if (ts.isJsxExpression(parent)) return checker.getContextualType(parent);
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.right === node
  )
    return checker.getTypeAtLocation(parent.left);
  return ts.isTemplateSpan(parent)
    ? checker.getContextualType(node)
    : undefined;
}

/** The type whose call signatures declare what `owner` returns: a function expression's context, else its own type, as for a declaration, whose overloads leave its implementation out, or a getter, whose type is its property's and has no signature. */
function declaringType(
  checker: ts.TypeChecker,
  owner: ts.SignatureDeclaration,
): ts.Type {
  const context =
    ts.isArrowFunction(owner) || ts.isFunctionExpression(owner)
      ? contextOf(checker, owner)
      : undefined;
  return context ?? checker.getTypeAtLocation(owner);
}

/** The call signatures of `type` as tsgolint lists them: each union member's in turn, and an intersection's only when one member alone is callable. */
function callSignatures(type: ts.Type): readonly ts.Signature[] {
  if (type.isUnion()) return type.types.flatMap(callSignatures);
  if (!type.isIntersection()) return type.getCallSignatures();
  const callable = type.types
    .map(callSignatures)
    .filter((signatures) => signatures.length > 0);
  return callable.length === 1 ? (callable[0] ?? []) : [];
}

/** Whether a declared return in `returns` excuses an annotated function returning `sender`: the type itself, `any` or `unknown`, or, for an async function, one whose awaited type is the awaited `sender`, `any` or `unknown`. */
function annotationExcuses(
  checker: ts.TypeChecker,
  sender: ts.Type,
  returns: readonly ts.Type[],
  isAsync: boolean,
): boolean {
  return returns.some((declared) => {
    if (declared === sender || takesAnything(declared)) return true;
    if (!isAsync) return false;
    const awaited = checker.getAwaitedType(declared);
    return (
      awaited === checker.getAwaitedType(sender) ||
      (awaited !== undefined && takesAnything(awaited))
    );
  });
}

/** Whether a declared return in `returns` excuses a returned `any`, `any[]` or `Promise<any>`: `unknown`, `unknown[]` or a promise of `unknown`, each read without awaiting the declared return, or a `Promise<any>` that a function not async returns. */
function anyExcuses(
  checker: ts.TypeChecker,
  kind: Exclude<AnyKind, "safe">,
  returns: readonly ts.Type[],
  isAsync: boolean,
): boolean {
  if (kind === "Promise<any>" && !isAsync) return true;
  return returns.some((declared) => {
    if (kind === "any") return isUnknown(declared);
    if (kind === "any[]") return isUnknown(arrayElement(checker, declared));
    return isUnknown(checker.getAwaitedType(declared));
  });
}

/**
 * Whether returning `value` lets `any` out, as `typescript/no-unsafe-return`
 * judges it: by the call signatures of the type that declares the function's
 * return, a function expression's context or the function's own type. An own
 * annotation is excused when a signature returns that type, `any` or
 * `unknown`. An `any`, `any[]` or `Promise<any>` is reported unless a
 * signature returns `unknown`, `unknown[]` or `Promise<unknown>`, and another
 * type is compared with the first signature by {@link leaks}.
 */
export function returnLeaks(
  checker: ts.TypeChecker,
  value: ts.Expression,
): boolean {
  const owner = ownerOf(value);
  if (owner === undefined) return false;
  const sender = checker.getTypeAtLocation(value);
  const returns = callSignatures(declaringType(checker, owner)).map(
    (signature) => signature.getReturnType(),
  );
  const isAsync =
    ts.canHaveModifiers(owner) &&
    (ts
      .getModifiers(owner)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ??
      false);
  if (
    owner.type !== undefined &&
    annotationExcuses(checker, sender, returns, isAsync)
  )
    return false;
  const kind = anyKind(checker, sender);
  return kind === "safe"
    ? leaks(checker, sender, returns[0], value)
    : !anyExcuses(checker, kind, returns, isAsync);
}
