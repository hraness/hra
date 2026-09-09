# Agentic service provisioning

Prefer services that agents can provision and manage through supported commands.
For new infrastructure, check Vercel Marketplace for a suitable native product
first. Use Stripe Projects as a supported alternative when it covers the required
service more directly. These defaults guide new setup; they do not require moving
an existing application or replacing a provider chosen explicitly for the task.

## Choose the route

1. Identify the required resource and the existing owner-controlled account,
   project and environment. Reuse a suitable existing resource before creating
   another one.
2. Inspect the current Vercel Marketplace catalog. Confirm that the selected
   native product can create the required resource and supports its region,
   plan, persistence, networking and operational needs. A third-party listing
   that connects accounts or shares environment variables is a different operation.
3. If that route does not fit, inspect the Stripe Projects catalog and its
   provisioning preflight. Verify the exact service and parent plan, existing
   resource-linking support, account eligibility and any required authentication.
4. When neither catalog supports the operation, use the provider's supported
   CLI or API. Record the concrete capability gap and preserve the task's
   provider constraints. Use browser setup when the provider requires it.

Vercel documents native subscriptions and connectable accounts as different
[integration types](https://vercel.com/docs/integrations). Its CLI provides
[Marketplace discovery](https://vercel.com/docs/cli/integration).
[Stripe Projects](https://docs.stripe.com/projects) exposes a service catalog,
provisioning commands and managed credential delivery through its CLI plugin.
Use the installed command help and current catalog as the authority for available
operations rather than copying a historical product list.

## Provision within the task's authority

Make the resource, account, region, plan, recurring minimum, usage rates and any
available spending controls concrete before mutation. Estimates are not invoices
or spending limits. Continue setup already authorized by the task and budget;
ask only when a material choice, additional authority, authentication or a
provider restriction remains unresolved. The preference alone does not authorize
a paid upgrade, a duplicate account, broader access or a migration.

Run a provider's non-mutating preflight where available. Record mutation intent
and resulting resource identifiers without credentials. Reconcile an uncertain
creation before retrying so a transient failure does not create another service.
An account-link command may create an account; inspect its documented effect
before treating it as an inventory operation.

Keep generated `.env` files, local credential vaults, tokens and provider output
that contains secrets outside Git, public artifacts and logs. Use a private
provisioning directory when a command writes credentials into its working
directory. Map only the variables required by the intended environment;
connecting a provider must not copy executor or production secrets into a
frontend or preview deployment. Preserve required browser authentication and
provider terms or payment confirmations; a different route must not evade them.

## Verify the result

Read back the exact account, project, service, region and plan after provisioning.
Then verify the deployed source or image identity, health, restart behavior,
persistence, capacity and relevant recovery guarantees. Successful creation is
evidence of a resource, not of application readiness. Preserve existing data and
use isolated synthetic state for disruptive qualification until an approved
cutover provides its own recovery procedure.

The [local-efficiency plugin](local-efficiency-plugin.md) distributes this guidance
through its global Codex, global Claude and repository policy assets. Its existing
bootstrap and repository-adoption tools preserve unmanaged instructions. Updating
those canonical assets does not itself update every repository or provision an
external service; record actual adoption and deployment evidence separately.
