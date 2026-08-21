import {
  Skeleton,
  Spinner,
} from "@hra-internal/design-kit/react";

import { StandaloneThemeHeader } from "./standalone-theme-header";

export default function Loading() {
  return (
    <main className="state-page" id="main-content">
      <StandaloneThemeHeader />
      <section className="state-card state-card--loading" role="status">
        <div className="state-loading-row">
          <Spinner label="Loading" />
          <div>
            <Skeleton isText width="18rem" />
            <Skeleton isText width="11rem" />
          </div>
        </div>
      </section>
    </main>
  );
}
