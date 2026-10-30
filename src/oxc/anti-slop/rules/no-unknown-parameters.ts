import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

import {
  containsUnknownType,
  type FunctionParameter,
  functionParameterBindingName,
  functionParameterTypeAnnotation,
} from "../shared/function-parameters.ts";
import { isRuntimeFunction } from "../shared/type-guards.ts";

type ParameterOwner =
  | ESTree.ArrowFunctionExpression
  | ESTree.Function
  | ESTree.TSCallSignatureDeclaration
  | ESTree.TSConstructSignatureDeclaration
  | ESTree.TSConstructorType
  | ESTree.TSFunctionType
  | ESTree.TSMethodSignature;

function isTypePredicateSubject(owner: ParameterOwner, parameterName: string): boolean {
  const predicate = owner.returnType?.typeAnnotation;
  return (
    predicate?.type === "TSTypePredicate" &&
    predicate.parameterName.type === "Identifier" &&
    predicate.parameterName.name === parameterName
  );
}

/** Parameter decorators that inject a request value: interface-api's `JSONBody` and `Parameter`, and dms-lang's `JsonBody`. The decorated parameter is the I/O boundary the value is decoded at. */
const BOUNDARY_PARAMETER_DECORATORS: ReadonlySet<string> = new Set(["JSONBody", "JsonBody", "Parameter"]);

function decoratorName(decorator: ESTree.Decorator): string | null {
  const target =
    decorator.expression.type === "CallExpression" ? decorator.expression.callee : decorator.expression;
  return target.type === "Identifier" ? target.name : null;
}

function hasBoundaryDecorator(parameter: FunctionParameter): boolean {
  return (parameter.decorators ?? []).some((decorator) => {
    const name = decoratorName(decorator);
    return name !== null && BOUNDARY_PARAMETER_DECORATORS.has(name);
  });
}

function isThisParameter(parameter: FunctionParameter): boolean {
  return parameter.type === "Identifier" && parameter.name === "this";
}

/** Return whether a function is passed directly as argument `position` of a `.method(...)` call. */
function isMethodArgument(owner: ParameterOwner, method: string, position: number): boolean {
  const call = owner.parent;
  return (
    call.type === "CallExpression" &&
    call.arguments[position] === owner &&
    call.callee.type === "MemberExpression" &&
    !call.callee.computed &&
    call.callee.property.type === "Identifier" &&
    call.callee.property.name === method
  );
}

/** Return whether a callback is written directly as `.catch(onRejected)` or `.then(_, onRejected)`. */
function isRejectionCallback(owner: ParameterOwner): boolean {
  return (
    isRuntimeFunction(owner) &&
    (isMethodArgument(owner, "catch", 0) || isMethodArgument(owner, "then", 1))
  );
}

/** Return whether a binding is the second parameter of a `new Promise(...)` executor. */
function isPromiseExecutorReject(binding: ESTree.Node): boolean {
  const executor = binding.parent;
  if (executor === null || !isRuntimeFunction(executor) || executor.params[1] !== binding) return false;
  const construction = executor.parent;
  return (
    construction.type === "NewExpression" &&
    construction.arguments[0] === executor &&
    construction.callee.type === "Identifier" &&
    construction.callee.name === "Promise"
  );
}

/** Return whether a `(reason: unknown) => void` type is declared as a promise's `reject` or typed on a `new Promise` executor's reject parameter. */
function isRejectFunctionType(owner: ParameterOwner): boolean {
  if (
    owner.type !== "TSFunctionType" ||
    owner.params.length !== 1 ||
    owner.returnType.typeAnnotation.type !== "TSVoidKeyword" ||
    owner.parent.type !== "TSTypeAnnotation"
  ) {
    return false;
  }
  const holder = owner.parent.parent;
  if (holder.type === "TSPropertySignature" || holder.type === "PropertyDefinition") {
    return !holder.computed && holder.key.type === "Identifier" && holder.key.name === "reject";
  }
  return holder.type === "Identifier" && (holder.name === "reject" || isPromiseExecutorReject(holder));
}

/** Return whether a parameter is exempt whatever its name: `this`, a boundary-decorated request value, or a promise rejection reason. */
function isExemptPosition(owner: ParameterOwner, parameter: FunctionParameter): boolean {
  if (isThisParameter(parameter) || hasBoundaryDecorator(parameter)) return true;
  if (owner.params[0] === parameter && isRejectionCallback(owner)) return true;
  return isRejectFunctionType(owner);
}

/** Disallow unknown inputs except explicitly named error-cause enrichment. */
export const noUnknownParametersRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow explicitly unknown function parameters except `cause`, type-predicate subjects, `this`, request values injected by `@JSONBody`, `@JsonBody` or `@Parameter`, and promise rejection reasons; decode unknown input at its I/O boundary instead.",
    },
    messages: {
      unknownParameter:
        "Parameter `{{parameter}}` leaves input unparsed. Accept a named domain type; run the expected schema or parser at the I/O boundary before calling this function.",
    },
  },
  createOnce(context) {
    const checkParameters = (node: ParameterOwner) => {
      for (const parameter of node.params) {
        const annotation = functionParameterTypeAnnotation(parameter);
        if (annotation === null || annotation === undefined) continue;
        if (!containsUnknownType(annotation.typeAnnotation)) continue;
        if (isExemptPosition(node, parameter)) continue;
        const name = functionParameterBindingName(parameter, context.sourceCode);
        if (name === "cause" || isTypePredicateSubject(node, name)) continue;
        context.report({
          node: annotation.typeAnnotation,
          messageId: "unknownParameter",
          data: { parameter: name },
        });
      }
    };

    return {
      ArrowFunctionExpression: checkParameters,
      FunctionDeclaration: checkParameters,
      FunctionExpression: checkParameters,
      TSCallSignatureDeclaration: checkParameters,
      TSConstructSignatureDeclaration: checkParameters,
      TSConstructorType: checkParameters,
      TSDeclareFunction: checkParameters,
      TSEmptyBodyFunctionExpression: checkParameters,
      TSFunctionType: checkParameters,
      TSMethodSignature: checkParameters,
    };
  },
});
