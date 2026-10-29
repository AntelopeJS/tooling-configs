import { defineRule } from "@oxlint/plugins";

/** A type predicate must check what it narrows to, not only that a key is present. */
export const noPresenceOnlyTypeGuardRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow type predicates that narrow on `in` alone: a key answered by the prototype, or a member whose value is never checked.",
    },
    messages: {
      inheritedKey: "stub",
      presenceOnly: "stub",
      uncheckedMember: "stub",
    },
  },
  createOnce() {
    return {};
  },
});
