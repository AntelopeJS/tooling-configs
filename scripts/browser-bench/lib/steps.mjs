export const VIEWPORT = { width: 1280, height: 900 };
export const ACCOUNTS = ["alice", "bob", "carol"];

const COLD_STEPS = [
  { op: "goto", path: "/login.html" },
  { op: "snapshot", expect: ["Sign in", "Email address", "Login"] },
];

const SESSION_STEPS = [
  { op: "goto", path: "/login.html" },
  { op: "snapshot", expect: ["Sign in", "Email address"] },
  { op: "click", role: "textbox", name: "Email address" },
  {
    op: "fill",
    role: "textbox",
    name: "Email address",
    value: "agent@example.com",
  },
  { op: "fill", role: "textbox", name: "Password", value: "hunter2" },
  { op: "press", key: "Enter" },
  { op: "waitUrl", glob: "**/list.html*" },
  { op: "snapshot", expect: ["Orders", "Row 200 of 200", "Select row 120"] },
  { op: "click", role: "button", name: "Select row 120" },
  { op: "waitText", text: "Selected row 120" },
  { op: "screenshot", full: true, minHeight: 6000 },
  { op: "goto", path: "/dialog.html" },
  { op: "click", role: "button", name: "Open dialog" },
  { op: "snapshot", expect: ["Rename", "Name", "Save"] },
  { op: "fill", role: "textbox", name: "Name", value: "Ada" },
  { op: "press", key: "Enter" },
  { op: "waitText", text: "Saved Ada" },
  { op: "click", role: "button", name: "Add item" },
  { op: "snapshot", expect: ["Items: 1", "Saved Ada"] },
  { op: "screenshot", full: false, maxHeight: 900 },
];

/**
 * Three accounts that are all alive at once. Each reads a localStorage key
 * before it writes its own, so a shared context shows up as a non-null read.
 *
 * @returns {Array<Record<string, unknown>>} The steps, tagged with their account
 */
function accountSteps() {
  const gotos = ACCOUNTS.map((account) => ({
    account,
    op: "goto",
    path: "/login.html",
  }));
  const own = ACCOUNTS.flatMap((account) => [
    {
      account,
      op: "eval",
      js: "localStorage.getItem('who')",
      expectJson: null,
    },
    { account, op: "eval", js: `localStorage.setItem('who', '${account}')` },
    {
      account,
      op: "fill",
      role: "textbox",
      name: "Email address",
      value: `${account}@example.com`,
    },
    {
      account,
      op: "fill",
      role: "textbox",
      name: "Password",
      value: "hunter2",
    },
    { account, op: "snapshot", expect: ["Sign in", "Login"] },
  ]);
  return [...gotos, ...own];
}

export const IDLE_PREP = [
  { op: "goto", path: "/list.html" },
  { op: "snapshot", expect: ["Orders", "Row 200 of 200"] },
];

const LATENCY_CALLS = 30;
export const LATENCY_STEPS = Array.from({ length: LATENCY_CALLS }, () => ({
  op: "url",
}));

export const SCENARIO_STEPS = {
  cold: COLD_STEPS,
  session: SESSION_STEPS,
  "session-warm": SESSION_STEPS,
  accounts: accountSteps(),
};

/**
 * @param {Record<string, unknown>} step The step
 * @param {number} index Zero-based position
 * @returns {string} A label such as `08 snapshot`
 */
export function labelOf(step, index) {
  return `${String(index + 1).padStart(2, "0")} ${step.op}${step.account ? ` ${step.account}` : ""}`;
}
