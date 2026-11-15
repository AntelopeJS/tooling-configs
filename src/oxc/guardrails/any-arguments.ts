import ts from "typescript";

import {
  arrayElement,
  isAnyOrAnyArray,
  isAnyType,
  isObjectType,
  isReference,
  leaks,
} from "./any-leaks.ts";

/** What a rest parameter takes: its element type, the types of the tuple it declares from its position on, or its own type when it is neither. */
type Rest =
  | { kind: "element"; type: ts.Type }
  | { kind: "tuple"; types: readonly ts.Type[]; index: number };

/** The parameter types of a call's resolved signature, read in turn as its arguments fill them, as typescript-eslint's `FunctionSignature` reads them. */
interface ParameterCursor {
  /** The type of the parameter the next argument fills, `undefined` past the last one. */
  next(): ts.Type | undefined;
  /** Sends every later argument to the rest parameter, as after a spread of a tuple with a rest element. */
  consumeRest(): void;
}

/** A tuple reference and the tuple type it instantiates. */
interface Tuple {
  reference: ts.TypeReference;
  target: ts.TupleType;
}

function isTupleTarget(target: ts.GenericType): target is ts.TupleType {
  return (target.objectFlags & ts.ObjectFlags.Tuple) !== 0;
}

function tupleOf(type: ts.Type): Tuple | undefined {
  if (!isObjectType(type) || !isReference(type)) return undefined;
  const { target } = type;
  return isTupleTarget(target) ? { reference: type, target } : undefined;
}

function restOf(checker: ts.TypeChecker, type: ts.Type, index: number): Rest {
  const element = arrayElement(checker, type);
  if (element !== undefined) return { kind: "element", type: element };
  const tuple = tupleOf(type);
  return tuple === undefined
    ? { kind: "element", type }
    : {
        kind: "tuple",
        types: checker.getTypeArguments(tuple.reference),
        index,
      };
}

/** An expression whose arguments fill a signature's parameters: a call, a `new`, or a tagged template, whose substitutions follow its template strings. */
type Call = ts.CallExpression | ts.NewExpression | ts.TaggedTemplateExpression;

function calleeOf(call: Call): ts.Expression {
  return ts.isTaggedTemplateExpression(call) ? call.tag : call.expression;
}

function argumentsOf(call: Call): readonly ts.Expression[] {
  if (!ts.isTaggedTemplateExpression(call)) return call.arguments ?? [];
  return ts.isTemplateExpression(call.template)
    ? call.template.templateSpans.map((span) => span.expression)
    : [];
}

function parameterCursor(
  checker: ts.TypeChecker,
  call: Call,
  signature: ts.Signature,
): ParameterCursor {
  const fixed: ts.Type[] = [];
  let rest: Rest | undefined;
  for (const [index, parameter] of signature.getParameters().entries()) {
    const type = checker.getTypeOfSymbolAtLocation(parameter, call);
    const declaration = parameter.getDeclarations()?.[0];
    if (
      declaration !== undefined &&
      ts.isParameter(declaration) &&
      declaration.dotDotDotToken !== undefined
    ) {
      rest = restOf(checker, type, index);
      break;
    }
    fixed.push(type);
  }
  let position = 0;
  let consumed = false;
  return {
    next() {
      const index = position;
      position += 1;
      if (index < fixed.length && !consumed) return fixed[index];
      if (rest === undefined) return undefined;
      if (rest.kind === "element") return rest.type;
      const last = rest.types.at(-1);
      return consumed ? last : (rest.types[index - rest.index] ?? last);
    },
    consumeRest() {
      consumed = true;
    },
  };
}

/**
 * The arguments of `call` that pass `any` to a typed parameter, as
 * `typescript/no-unsafe-argument` reports them: each argument against the
 * parameter it fills, a spread `any` or `any[]` once, and each element of a
 * spread tuple against the parameter that element fills, so one spread can be
 * reported once per element. The substitutions of a tagged template fill the
 * parameters after the one its template strings fill. A call whose callee is
 * `any` is left alone.
 */
export function unsafeArguments(
  checker: ts.TypeChecker,
  call: Call,
): ts.Expression[] {
  const args = argumentsOf(call);
  if (
    args.length === 0 ||
    isAnyType(checker, checker.getTypeAtLocation(calleeOf(call)))
  )
    return [];
  const signature = checker.getResolvedSignature(call);
  if (signature === undefined) return [];
  const cursor = parameterCursor(checker, call, signature);
  if (ts.isTaggedTemplateExpression(call)) cursor.next();
  return args.flatMap((argument) => {
    if (!ts.isSpreadElement(argument)) {
      const parameter = cursor.next();
      return parameter !== undefined &&
        leaks(checker, checker.getTypeAtLocation(argument), parameter, argument)
        ? [argument]
        : [];
    }
    const spread = checker.getTypeAtLocation(argument.expression);
    if (isAnyOrAnyArray(checker, spread)) return [argument];
    const tuple = tupleOf(spread);
    if (tuple === undefined) return [];
    const unsafe = checker
      .getTypeArguments(tuple.reference)
      .flatMap((element) => {
        const parameter = cursor.next();
        return parameter !== undefined && leaks(checker, element, parameter)
          ? [argument]
          : [];
      });
    if ((tuple.target.combinedFlags & ts.ElementFlags.Variable) !== 0)
      cursor.consumeRest();
    return unsafe;
  });
}
