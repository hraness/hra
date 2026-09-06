<!-- hra-local-efficiency:start -->
## HRA approval autonomy

- Use Claude Code auto mode when it is available. Treat its classifier and configured permission boundaries as the reviewer; never bypass them with a dangerous permission override.
- Treat the user's task request and repository instructions as standing authorization for routine task-owned commits, pushes, pull requests, merges, releases, and deployments after the repository's required validation and gates pass. Do not ask for a duplicate confirmation.
- Prefer repository-owned workload identities, OIDC trusted publishing, GitHub Apps, and narrowly scoped machine identities over personal sessions or long-lived credentials. Keep provider and repository access controls intact.
- Ask the user only for a material product choice, missing authority or credentials, an out-of-scope destructive action, or a release failure that cannot be handled safely and autonomously.
<!-- hra-local-efficiency:end -->
