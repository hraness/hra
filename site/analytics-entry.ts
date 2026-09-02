import { initializePostHogBrowser } from "@hraness/posthog/client";

import { hraPostHogSite } from "./analytics-site.ts";

declare const __HRA_POSTHOG_PROJECT_TOKEN__: string;

initializePostHogBrowser({
  apiKey: __HRA_POSTHOG_PROJECT_TOKEN__,
  site: hraPostHogSite,
});
