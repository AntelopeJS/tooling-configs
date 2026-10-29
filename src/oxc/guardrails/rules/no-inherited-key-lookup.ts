import { defineRule } from "@oxlint/plugins";

/** Lookups into string-keyed object tables must not answer inherited `Object.prototype` keys. */
export const noInheritedKeyLookupRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow reading a string-keyed object table with a computed key, or testing it with `in`, without an own-key check.",
    },
    messages: {
      lookup: "stub",
      inOperator: "stub",
    },
  },
  createOnce() {
    return {};
  },
});
