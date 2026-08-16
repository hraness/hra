import type { SuiteUsername } from "./suite-account-contracts";

/** The only HRA-visible profile state carried by the OIDC session. */
export type HraSuiteProfile =
  | Readonly<{
      profileComplete: false;
      profileRevision: "username-v1" | null;
      username: null;
    }>
  | Readonly<{
      profileComplete: true;
      profileRevision: "username-v1";
      username: SuiteUsername;
    }>;
