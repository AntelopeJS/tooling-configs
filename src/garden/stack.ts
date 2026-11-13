const FRAMEWORK = new Set(["antelopejs", "tooling-configs", "dms"]);
const MODULES = new Set([
  "api",
  "auth-jwt",
  "brevo",
  "brevo-private",
  "cdn",
  "checkout-com",
  "mailchimp",
  "mollie",
  "mongodb",
  "mqtt",
  "mysql",
  "nodemailer",
  "payment-subscriptions",
  "postgres",
  "redis",
  "rethinkdb",
  "stripe",
]);
const FAMILIES = ["interface-", "file-storage-", "template-", "dms-"] as const;
const RETIRED = new Set(["dms-builder"]);

/** Whether a repository belongs to the framework and DMS stack, whose CI must run on Windows: the framework, its interfaces, modules and templates, and the DMS repositories. */
export function isStackRepo(name: string): boolean {
  if (RETIRED.has(name)) return false;
  return (
    FRAMEWORK.has(name) ||
    MODULES.has(name) ||
    FAMILIES.some((prefix) => name.startsWith(prefix))
  );
}
