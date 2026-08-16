"use client";

import { Cancel01Icon } from "@hugeicons/core-free-icons";
import type { ReactNode } from "react";
import {
  Dialog as AriaDialog,
  DialogTrigger,
  Heading,
  Modal as AriaModal,
  ModalOverlay,
  type ModalOverlayProps,
  Text,
} from "react-aria-components";

import { IconButton } from "./button";
import { classNames } from "./class-names";
import { useDesignPortalClassName, useDesignPortalTheme } from "./design-theme-context";
import { Icon } from "./icon";
import { JellySurface } from "./jelly-surface";

export { DialogTrigger };

export type ModalCloseOptions = { readonly close: () => void };

export type ModalProps = Omit<ModalOverlayProps, "children" | "className"> & {
  readonly children: ReactNode | ((options: ModalCloseOptions) => ReactNode);
  readonly className?: string;
  readonly closeLabel?: string;
  readonly description?: ReactNode;
  readonly footer?: ReactNode | ((options: ModalCloseOptions) => ReactNode);
  readonly isCloseDisabled?: boolean;
  readonly size?: "large" | "medium" | "small";
  readonly surfaceClassName?: string;
  readonly title: ReactNode;
};

export function Modal({
  children,
  className,
  closeLabel = "Close dialog",
  description,
  footer,
  isCloseDisabled = false,
  isDismissable = true,
  size = "medium",
  surfaceClassName,
  title,
  ...overlayProps
}: ModalProps) {
  const designTheme = useDesignPortalTheme();
  const portalClassName = useDesignPortalClassName();

  return (
    <ModalOverlay
      {...overlayProps}
      className={classNames("jungle-modal-overlay", portalClassName)}
      data-theme={designTheme}
      isDismissable={isDismissable}
    >
      <JellySurface
        className={classNames("jungle-modal__surface", surfaceClassName)}
        data-size={size}
        tone="overlay"
      >
        <AriaModal className={classNames("jungle-modal", className)} data-size={size}>
          <AriaDialog className="jungle-modal__dialog">
            {({ close }) => (
              <>
                <header className="jungle-modal__header">
                  <div className="jungle-modal__heading">
                    <Heading className="jungle-modal__title" slot="title">{title}</Heading>
                    {description === undefined ? null : (
                      <Text className="jungle-modal__description" slot="description">{description}</Text>
                    )}
                  </div>
                  <IconButton
                    aria-label={closeLabel}
                    className="jungle-modal__close"
                    isDisabled={isCloseDisabled}
                    onPress={close}
                    size="compact"
                  >
                    <Icon icon={Cancel01Icon} />
                  </IconButton>
                </header>
                <div className="jungle-modal__body">
                  {typeof children === "function" ? children({ close }) : children}
                </div>
                {footer === undefined ? null : (
                  <footer className="jungle-modal__footer">
                    {typeof footer === "function" ? footer({ close }) : footer}
                  </footer>
                )}
              </>
            )}
          </AriaDialog>
        </AriaModal>
      </JellySurface>
    </ModalOverlay>
  );
}
