import { MARKDOWN_CONTENT_TYPE } from "../accept-negotiation";
import { HRA_LLMS_TXT } from "../public-markdown";

export function GET(): Response {
  return new Response(HRA_LLMS_TXT, {
    headers: {
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Content-Type": MARKDOWN_CONTENT_TYPE,
    },
  });
}

export function HEAD(): Response {
  return new Response(null, {
    headers: {
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Content-Type": MARKDOWN_CONTENT_TYPE,
    },
  });
}
