import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef } from "react";
import { mountOompaAppearanceMenu } from "../appearance";
import { NativeAppearanceMenu } from "./appearance-menu";
import { appearanceStyles } from "./appearance.stylex";

/** Each mounted header adopts the existing bootstrap controller and releases it. */
export function AppearanceButton() {
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const current = menu.current;
    if (current === null) return;
    return mountOompaAppearanceMenu(current);
  }, []);
  return <div {...stylex.props(appearanceStyles.control)}><NativeAppearanceMenu managed ref={menu} /></div>;
}

export function AppearanceHeader() {
  return (
    <header {...stylex.props(appearanceStyles.header)}>
      <AppearanceButton />
    </header>
  );
}
