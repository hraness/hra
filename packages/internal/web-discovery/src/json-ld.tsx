import type { ReactNode } from "react";

import { serializeJsonLd } from "./discovery";

export function JsonLdScript({
  data,
  id,
}: Readonly<{
  data: unknown;
  id: string;
}>): ReactNode {
  return (
    <script
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }}
      id={id}
      type="application/ld+json"
    />
  );
}
