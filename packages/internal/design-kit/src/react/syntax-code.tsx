import {
  highlightCode,
  type SyntaxLanguage,
} from "../syntax-highlighting";

export interface SyntaxCodeProps {
  readonly className?: string;
  readonly code: string;
  readonly language: SyntaxLanguage;
}

/** Server-rendered syntax markup with no client runtime or hydration cost. */
export function SyntaxCode({
  className,
  code,
  language,
}: SyntaxCodeProps) {
  const highlighted = highlightCode(code, language);
  const classes = className === undefined
    ? highlighted.className
    : `${highlighted.className} ${className}`;

  return (
    <code
      className={classes}
      data-language={highlighted.language}
      dangerouslySetInnerHTML={{ __html: highlighted.html }}
    />
  );
}
