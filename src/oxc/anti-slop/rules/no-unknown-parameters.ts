import { defineRule } from "@oxlint/plugins";
import type { ESTree, SourceCode } from "@oxlint/plugins";

import { isBrandProbe } from "../shared/brand-probe.ts";
import { isCaughtValueCallbackType } from "../shared/caught-callback.ts";
import {
  argumentParameters,
  containsUnknownType,
  type FunctionParameter,
  functionParameterBindingName,
  functionParameterTypeAnnotation,
  isThisParameter,
} from "../shared/function-parameters.ts";
import { forwardsOnly, isForward } from "../shared/forward-only.ts";
import { readsOnlyThroughGuards } from "../shared/guarded-reads.ts";
import { decodesParameterIntoResult, type FunctionFacts, IMPLICIT_READERS } from "../shared/parse-boundary.ts";
import { isRuntimeFunction, type RuntimeFunction } from "../shared/type-guards.ts";

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
  if (executor === null || !isRuntimeFunction(executor) || argumentParameters(executor)[1] !== binding) return false;
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
    argumentParameters(owner).length !== 1 ||
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
function isExemptPosition(owner: ParameterOwner, parameter: FunctionParameter, sourceCode: SourceCode): boolean {
  if (isThisParameter(parameter) || hasBoundaryDecorator(parameter)) return true;
  if (argumentParameters(owner)[0] === parameter && isRejectionCallback(owner)) return true;
  return isRejectFunctionType(owner) || (owner.type === "TSFunctionType" && isCaughtValueCallbackType(owner, sourceCode));
}

/** Return whether a parameter typed exactly `unknown` is only probed for a symbol-keyed brand this file creates, see `isBrandProbe`. */
function probesBrand(
  owner: RuntimeFunction,
  name: string,
  annotated: ESTree.TSType,
  facts: FunctionFacts,
  sourceCode: SourceCode,
): boolean {
  if (annotated.type !== "TSUnknownKeyword" || facts.readsImplicitly) return false;
  const parameter = sourceCode
    .getDeclaredVariables(owner)
    .find((variable) => variable.name === name && variable.defs[0]?.type === "Parameter");
  return isBrandProbe(owner, parameter, sourceCode);
}

/** The facts of a function the rule did not walk: a signature with no body. */
const NO_FACTS: FunctionFacts = { returns: [], readsImplicitly: false };

/** Disallow unknown inputs except explicitly named error-cause enrichment. */
export const noUnknownParametersRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow explicitly unknown function parameters except `cause`, type-predicate subjects, `this`, request values injected by `@JSONBody`, `@JsonBody` or `@Parameter`, promise rejection reasons, the parameter of a callback type that the function only calls with a caught value, a symbol-keyed brand probe, a parameter a function only decodes through a schema or decoder into the value it returns, a parameter a function only reads through type guards, where they hold and short of handing on as is a value only a loose guard narrowed, and through `String` or `JSON.stringify`, to classify it into a declared value other than a yes-or-no verdict or `void`, also beside forwards once one of them is a type test, and a parameter a function only forwards, unread, to member calls not rooted at another parameter, imports, callees a variable holds from another call's result, or exempt same-file parameters that take `unknown`; decode unknown input at its I/O boundary instead.",
    },
    messages: {
      unknownParameter:
        "Parameter `{{parameter}}` leaves input unparsed. Accept a named domain type and run the expected schema or parser at the I/O boundary before calling this function, or make this function that parser: pass the parameter only to the schema and return its result under a declared type.",
    },
  },
  createOnce(context) {
    const open: { returns: ESTree.ReturnStatement[]; readsImplicitly: boolean }[] = [];
    /** The checks of one file, in the order they were met. They run at its end, so a forward is judged by a function declared after it. */
    const pending: { node: ParameterOwner; facts: FunctionFacts }[] = [];
    const walked = new Map<RuntimeFunction, FunctionFacts>();
    /** The parameters a forward is being judged into. A forward back to one of them is not exempt. */
    const judging = new Set<FunctionParameter>();
    /** The verdicts on parameters a forward landed on, so a chain of forwarders judges each parameter once. */
    const verdicts = new Map<FunctionParameter, boolean>();

    const isExempt = (
      node: ParameterOwner,
      parameter: FunctionParameter,
      annotated: ESTree.TSType,
      facts: FunctionFacts,
    ): boolean => {
      const { sourceCode } = context;
      if (isExemptPosition(node, parameter, sourceCode)) return true;
      const name = functionParameterBindingName(parameter, sourceCode);
      if (name === "cause" || isTypePredicateSubject(node, name)) return true;
      if (!isRuntimeFunction(node)) return false;
      const targets = { sourceCode, accepts: acceptsForward };
      return (
        decodesParameterIntoResult(node, name, annotated, facts, sourceCode) ||
        probesBrand(node, name, annotated, facts, sourceCode) ||
        readsOnlyThroughGuards(node, name, annotated, facts, { sourceCode, forwards: (read) => isForward(read, targets) }) ||
        forwardsOnly(node, name, annotated, facts, targets)
      );
    };

    /** Return whether this rule exempts the parameter at `position` of a function the file declares, so a forward to it hands the value to a parser. */
    const acceptsForward = (callee: RuntimeFunction, position: number): boolean => {
      const parameter = argumentParameters(callee)[position];
      if (parameter === undefined || judging.has(parameter)) return false;
      const known = verdicts.get(parameter);
      if (known !== undefined) return known;
      const annotation = functionParameterTypeAnnotation(parameter);
      const facts = walked.get(callee);
      if (annotation === null || annotation === undefined || facts === undefined) return false;
      judging.add(parameter);
      const exempt = isExempt(callee, parameter, annotation.typeAnnotation, facts);
      judging.delete(parameter);
      verdicts.set(parameter, exempt);
      return exempt;
    };

    const checkParameters = (node: ParameterOwner, facts: FunctionFacts) => {
      for (const parameter of node.params) {
        const annotation = functionParameterTypeAnnotation(parameter);
        if (annotation === null || annotation === undefined) continue;
        if (!containsUnknownType(annotation.typeAnnotation)) continue;
        if (isExempt(node, parameter, annotation.typeAnnotation, facts)) continue;
        context.report({
          node: annotation.typeAnnotation,
          messageId: "unknownParameter",
          data: { parameter: functionParameterBindingName(parameter, context.sourceCode) },
        });
      }
    };

    const checkSignature = (node: ParameterOwner) => {
      pending.push({ node, facts: NO_FACTS });
    };
    const enterFunction = () => {
      open.push({ returns: [], readsImplicitly: false });
    };
    const leaveFunction = (node: RuntimeFunction) => {
      const facts = open.pop() ?? NO_FACTS;
      walked.set(node, facts);
      pending.push({ node, facts });
    };

    return {
      Program() {
        pending.length = 0;
        walked.clear();
        verdicts.clear();
      },
      "Program:exit"() {
        for (const { node, facts } of pending) checkParameters(node, facts);
      },
      ArrowFunctionExpression: enterFunction,
      FunctionDeclaration: enterFunction,
      FunctionExpression: enterFunction,
      "ArrowFunctionExpression:exit": leaveFunction,
      "FunctionDeclaration:exit": leaveFunction,
      "FunctionExpression:exit": leaveFunction,
      ReturnStatement(node) {
        open.at(-1)?.returns.push(node);
      },
      Identifier(node) {
        if (!IMPLICIT_READERS.has(node.name)) return;
        for (const frame of open) frame.readsImplicitly = true;
      },
      TSCallSignatureDeclaration: checkSignature,
      TSConstructSignatureDeclaration: checkSignature,
      TSConstructorType: checkSignature,
      TSDeclareFunction: checkSignature,
      TSEmptyBodyFunctionExpression: checkSignature,
      TSFunctionType: checkSignature,
      TSMethodSignature: checkSignature,
    };
  },
});
