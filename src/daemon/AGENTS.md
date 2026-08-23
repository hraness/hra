# Contents

- The daemon hosts the local command authority and long-running Codex processes.
- The Unix socket transports one bounded authenticated request at a time.

# Guidelines

- Authenticate with an ephemeral capability stored in a user-only file. Never accept a socket, capability, or state root through argv or environment overrides in production.
- Validate owner, mode, type, link count, containment, and canonical path before using an endpoint.
- Use absolute wall-clock deadlines, close admission before shutdown, abort in-flight reads, and join every owned task before storage closes.
- Serialize mutations by their authority key. Allow bounded independent reads that cannot observe torn state.
