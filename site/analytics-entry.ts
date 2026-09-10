import { initializePostHogBrowser } from "@hraness/posthog/client";

import { oompaPostHogSite } from "./analytics-site.ts";

declare const __OOMPA_POSTHOG_PROJECT_TOKEN__: string;

initializePostHogBrowser({
  apiKey: __OOMPA_POSTHOG_PROJECT_TOKEN__,
  site: oompaPostHogSite,
});
