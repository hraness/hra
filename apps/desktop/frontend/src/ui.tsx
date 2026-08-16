import {
  type AriaAttributes,
  type ChangeEvent,
  forwardRef,
  type ReactElement,
  type ReactNode,
  type Ref,
  type SelectHTMLAttributes,
  useId,
} from "react";
import {
  Button as AriaButton,
  type ButtonProps as AriaButtonProps,
  type ButtonRenderProps,
  FieldError as AriaFieldError,
  Input as AriaInput,
  type InputProps as AriaInputProps,
  Keyboard,
  Label,
  Link as AriaLink,
  type LinkProps as AriaLinkProps,
  type LinkRenderProps,
  Menu as AriaMenu,
  MenuItem as AriaMenuItem,
  type MenuItemProps as AriaMenuItemProps,
  type MenuProps as AriaMenuProps,
  MenuTrigger,
  Popover as AriaPopover,
  type Placement,
  SwitchButton as AriaSwitchButton,
  SwitchField as AriaSwitchField,
  type SwitchFieldProps as AriaSwitchFieldProps,
  Text,
  TextArea as AriaTextArea,
  type TextAreaProps as AriaTextAreaProps,
  TextField as AriaTextField,
  type TextFieldProps as AriaTextFieldProps,
  ToggleButton as AriaToggleButton,
  type ToggleButtonProps as AriaToggleButtonProps,
  type ToggleButtonRenderProps,
  Tooltip as AriaTooltip,
  TooltipTrigger,
  type ValidationResult,
} from "react-aria-components";

export { MenuTrigger };

type ActionVariant = "danger" | "primary" | "quiet" | "secondary";
type ActionSize = "compact" | "default" | "large";
type FieldSize = "compact" | "default" | "large";
type FieldSurface = "card" | "default" | "pane";
type FieldErrorMessage = ReactNode | ((validation: ValidationResult) => ReactNode);

type BusyAriaProps = Readonly<{
  "aria-busy"?: AriaAttributes["aria-busy"];
}>;

type AccessibleName =
  | Readonly<{
      "aria-label": string;
      "aria-labelledby"?: never;
    }>
  | Readonly<{
      "aria-label"?: never;
      "aria-labelledby": string;
    }>;

type AccessibleIconName =
  | Readonly<{
      "aria-label": string;
      "aria-labelledby"?: never;
      tooltip?: ReactNode;
    }>
  | Readonly<{
      "aria-label"?: never;
      "aria-labelledby": string;
      tooltip: ReactNode;
    }>;

function classNames(...values: readonly (false | null | string | undefined)[]): string {
  return values.filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ");
}

function isAriaTrue(value: AriaAttributes["aria-busy"]): boolean {
  return value === true || value === "true";
}

function requireNonBlank(value: unknown, component: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${component} ${field} must not be blank.`);
  }
}

function validateAccessibleName(
  props: Partial<Record<"aria-label" | "aria-labelledby", unknown>>,
  component: string,
): void {
  if (props["aria-label"] !== undefined) {
    requireNonBlank(props["aria-label"], component, "aria-label");
    return;
  }
  requireNonBlank(props["aria-labelledby"], component, "aria-labelledby");
}

function iconTooltip(props: AccessibleIconName, component: string): ReactNode {
  validateAccessibleName(props, component);
  const tooltip = props.tooltip ?? props["aria-label"];
  if (tooltip === undefined || tooltip === null || tooltip === false) {
    throw new Error(`${component} tooltip must be provided with aria-labelledby.`);
  }
  if (typeof tooltip === "string") requireNonBlank(tooltip, component, "tooltip");
  return tooltip;
}

function resolveButtonChildren(
  children: AriaButtonProps["children"],
  values: ButtonRenderProps & Readonly<{ defaultChildren: ReactNode | undefined }>,
): ReactNode {
  return typeof children === "function" ? children(values) : children;
}

function resolveToggleButtonChildren(
  children: AriaToggleButtonProps["children"],
  values: ToggleButtonRenderProps & Readonly<{ defaultChildren: ReactNode | undefined }>,
): ReactNode {
  return typeof children === "function" ? children(values) : children;
}

function resolveLinkChildren(
  children: AriaLinkProps["children"],
  values: LinkRenderProps & Readonly<{ defaultChildren: ReactNode | undefined }>,
): ReactNode {
  return typeof children === "function" ? children(values) : children;
}

function PendingIndicator({ className }: Readonly<{ className?: string }>) {
  return (
    <span
      aria-hidden="true"
      className={classNames("hraness-action__spinner", className)}
      data-slot="action-spinner"
    />
  );
}

function ActionTooltip({
  children,
  content,
}: Readonly<{ children: ReactElement; content: ReactNode }>) {
  return (
    <TooltipTrigger closeDelay={500} delay={500}>
      {children}
      <AriaTooltip
        className="hraness-tooltip"
        data-slot="tooltip"
        offset={8}
        placement="top"
      >
        {content}
      </AriaTooltip>
    </TooltipTrigger>
  );
}

export type ButtonProps = Omit<AriaButtonProps, "className"> &
  BusyAriaProps &
  Readonly<{
    className?: string;
    controlClassName?: string;
    leading?: ReactNode;
    size?: ActionSize;
    variant?: ActionVariant;
  }>;

export const Button = forwardRef<HTMLButtonElement, ButtonProps>((allProps, ref) => {
  const reservesPendingSlot = Object.prototype.hasOwnProperty.call(allProps, "isPending");
  const {
    "aria-busy": ariaBusy,
    children,
    className,
    controlClassName,
    isDisabled = false,
    isPending = false,
    leading,
    size = "default",
    variant = "secondary",
    ...props
  } = allProps;
  const isBusy = isPending || isAriaTrue(ariaBusy);
  const isNativelyDisabled = isDisabled && !isPending;
  const hasLeading = leading !== undefined && leading !== null && leading !== false;
  const hasLeadingSlot = hasLeading || reservesPendingSlot;

  return (
    <span
      aria-busy={isBusy ? "true" : undefined}
      className={classNames("hraness-button", className)}
      data-disabled={isNativelyDisabled || undefined}
      data-pending={isPending || undefined}
      data-size={size}
      data-slot="button"
      data-variant={variant}
    >
      <AriaButton
        {...props}
        aria-busy={isBusy ? "true" : undefined}
        className={classNames("hraness-button__control", controlClassName)}
        data-slot="button-control"
        isDisabled={isNativelyDisabled}
        isPending={isPending}
        ref={ref}
      >
        {(values) => (
          <>
            {hasLeadingSlot ? (
              <span
                aria-hidden="true"
                className="hraness-button__leading"
                data-empty={!isPending && !hasLeading ? "true" : undefined}
                data-slot="button-leading"
              >
                {isPending ? <PendingIndicator /> : leading}
              </span>
            ) : null}
            <span className="hraness-button__label" data-slot="button-label">
              {resolveButtonChildren(children, values)}
            </span>
          </>
        )}
      </AriaButton>
    </span>
  );
});

Button.displayName = "Button";

export type IconButtonProps = Omit<
  AriaButtonProps,
  "aria-label" | "aria-labelledby" | "className" | "title"
> &
  AccessibleIconName &
  BusyAriaProps &
  Readonly<{
    buttonRef?: Ref<HTMLButtonElement>;
    className?: string;
    controlClassName?: string;
    size?: ActionSize;
    variant?: ActionVariant;
  }>;

export function IconButton(allProps: IconButtonProps) {
  const tooltipContent = iconTooltip(allProps, "IconButton");
  const {
    "aria-busy": ariaBusy,
    buttonRef,
    children,
    className,
    controlClassName,
    isDisabled = false,
    isPending = false,
    size = "default",
    tooltip,
    variant = "quiet",
    ...props
  } = allProps;
  const isBusy = isPending || isAriaTrue(ariaBusy);
  const isNativelyDisabled = isDisabled && !isPending;

  return (
    <span
      aria-busy={isBusy ? "true" : undefined}
      className={classNames("hraness-icon-button", className)}
      data-disabled={isNativelyDisabled || undefined}
      data-pending={isPending || undefined}
      data-size={size}
      data-slot="icon-button"
      data-variant={variant}
    >
      <ActionTooltip content={tooltip ?? tooltipContent}>
        <AriaButton
          {...props}
          aria-busy={isBusy ? "true" : undefined}
          className={classNames("hraness-icon-button__control", controlClassName)}
          data-slot="icon-button-control"
          isDisabled={isNativelyDisabled}
          isPending={isPending}
          ref={buttonRef}
        >
          {(values) => (
            <span
              className="hraness-icon-button__content"
              data-slot="icon-button-content"
            >
              {isPending
                ? <PendingIndicator className="hraness-icon-button__spinner" />
                : resolveButtonChildren(children, values)}
            </span>
          )}
        </AriaButton>
      </ActionTooltip>
    </span>
  );
}

type ToggleButtonBaseProps = Omit<
  AriaToggleButtonProps,
  "aria-label" | "aria-labelledby" | "className"
> &
  Readonly<{
    buttonRef?: Ref<HTMLButtonElement>;
    className?: string;
    controlClassName?: string;
    leading?: ReactNode;
    size?: ActionSize;
    variant?: ActionVariant;
  }>;

type ToggleButtonNameProps =
  | (AccessibleName & Readonly<{ isIconOnly: true }>)
  | Readonly<{
      "aria-label"?: string;
      "aria-labelledby"?: string;
      isIconOnly?: false;
    }>;

export type ToggleButtonProps = ToggleButtonBaseProps & ToggleButtonNameProps;

export function ToggleButton(allProps: ToggleButtonProps) {
  const {
    buttonRef,
    children,
    className,
    controlClassName,
    isDisabled = false,
    isIconOnly = false,
    leading,
    size = "default",
    variant = "secondary",
    ...props
  } = allProps;
  if (isIconOnly) validateAccessibleName(allProps, "ToggleButton");
  const hasLeading = leading !== undefined && leading !== null && leading !== false;

  return (
    <span
      className={classNames("hraness-toggle-button", className)}
      data-disabled={isDisabled || undefined}
      data-icon-only={isIconOnly || undefined}
      data-size={size}
      data-slot="toggle-button"
      data-variant={variant}
    >
      <AriaToggleButton
        {...props}
        className={classNames("hraness-toggle-button__control", controlClassName)}
        data-slot="toggle-button-control"
        isDisabled={isDisabled}
        ref={buttonRef}
      >
        {(values) => (
          <>
            {hasLeading ? (
              <span
                aria-hidden="true"
                className="hraness-toggle-button__leading"
                data-slot="toggle-button-leading"
              >
                {leading}
              </span>
            ) : null}
            {resolveToggleButtonChildren(children, values)}
          </>
        )}
      </AriaToggleButton>
    </span>
  );
}

type RequiredHref = NonNullable<AriaLinkProps["href"]>;

export type IconLinkProps = Omit<
  AriaLinkProps,
  "aria-label" | "aria-labelledby" | "className" | "href" | "title"
> &
  AccessibleIconName &
  Readonly<{
    className?: string;
    controlClassName?: string;
    href: RequiredHref;
    linkRef?: Ref<HTMLAnchorElement>;
    size?: ActionSize;
    variant?: ActionVariant;
  }>;

export function IconLink(allProps: IconLinkProps) {
  const tooltipContent = iconTooltip(allProps, "IconLink");
  const {
    children,
    className,
    controlClassName,
    href,
    isDisabled = false,
    linkRef,
    size = "default",
    tooltip,
    variant = "quiet",
    ...props
  } = allProps;

  return (
    <span
      className={classNames("hraness-icon-button", "hraness-icon-link", className)}
      data-disabled={isDisabled || undefined}
      data-size={size}
      data-slot="icon-link"
      data-variant={variant}
    >
      <ActionTooltip content={tooltip ?? tooltipContent}>
        <AriaLink
          {...props}
          className={classNames(
            "hraness-icon-button__control",
            "hraness-icon-link__control",
            controlClassName,
          )}
          data-slot="icon-link-control"
          href={href}
          isDisabled={isDisabled}
          ref={linkRef}
        >
          {(values) => (
            <span
              className="hraness-icon-button__content hraness-icon-link__content"
              data-slot="icon-link-content"
            >
              {resolveLinkChildren(children, values)}
            </span>
          )}
        </AriaLink>
      </ActionTooltip>
    </span>
  );
}

type SharedTextFieldProps = Omit<AriaTextFieldProps, "children" | "className"> &
  Readonly<{
    className?: string;
    description?: ReactNode;
    errorMessage?: FieldErrorMessage;
    label: ReactNode;
    placeholder?: string;
    showLabel?: boolean;
    size?: FieldSize;
    surface?: FieldSurface;
  }>;

function FieldMessages({
  description,
  errorMessage,
}: Readonly<{
  description?: ReactNode;
  errorMessage?: FieldErrorMessage;
}>) {
  return (
    <>
      {description === undefined ? null : (
        <Text
          className="hraness-field__description"
          data-slot="field-description"
          slot="description"
        >
          {description}
        </Text>
      )}
      {errorMessage === undefined ? null : (
        <AriaFieldError className="hraness-field__error" data-slot="field-error">
          {errorMessage}
        </AriaFieldError>
      )}
    </>
  );
}

export type TextFieldProps = SharedTextFieldProps &
  Readonly<{
    inputClassName?: string;
    inputProps?: Omit<AriaInputProps, "className" | "placeholder">;
    inputRef?: Ref<HTMLInputElement>;
  }>;

export const TextField = forwardRef<HTMLDivElement, TextFieldProps>(({
  className,
  description,
  errorMessage,
  inputClassName,
  inputProps,
  inputRef,
  isDisabled = false,
  label,
  placeholder,
  showLabel = true,
  size = "default",
  surface = "default",
  ...props
}, ref) => (
  <AriaTextField
    {...props}
    className={classNames("hraness-field", "hraness-text-field", className)}
    data-size={size}
    data-slot="text-field"
    data-surface={surface}
    isDisabled={isDisabled}
    ref={ref}
  >
    <Label
      className={classNames("hraness-field__label", !showLabel && "hraness-visually-hidden")}
      data-slot="field-label"
    >
      {label}
    </Label>
    <div className="hraness-field__control" data-slot="field-control">
      <AriaInput
        {...inputProps}
        className={classNames("hraness-field__input", inputClassName)}
        data-slot="field-input"
        {...(placeholder === undefined ? {} : { placeholder })}
        ref={inputRef}
      />
    </div>
    <FieldMessages description={description} errorMessage={errorMessage} />
  </AriaTextField>
));

TextField.displayName = "TextField";

export type TextAreaFieldProps = SharedTextFieldProps &
  Readonly<{
    fieldRef?: Ref<HTMLDivElement>;
    resize?: "none" | "vertical";
    textAreaClassName?: string;
    textAreaProps?: Omit<AriaTextAreaProps, "className" | "placeholder">;
    textAreaRef?: Ref<HTMLTextAreaElement>;
  }>;

export function TextAreaField({
  className,
  description,
  errorMessage,
  fieldRef,
  isDisabled = false,
  label,
  placeholder,
  resize = "none",
  showLabel = true,
  size = "default",
  surface = "default",
  textAreaClassName,
  textAreaProps,
  textAreaRef,
  ...props
}: TextAreaFieldProps) {
  return (
    <AriaTextField
      {...props}
      className={classNames("hraness-field", "hraness-text-area-field", className)}
      data-resize={resize}
      data-size={size}
      data-slot="text-area-field"
      data-surface={surface}
      isDisabled={isDisabled}
      ref={fieldRef}
    >
      <Label
        className={classNames("hraness-field__label", !showLabel && "hraness-visually-hidden")}
        data-slot="field-label"
      >
        {label}
      </Label>
      <div className="hraness-field__control" data-slot="field-control">
        <AriaTextArea
          {...textAreaProps}
          className={classNames("hraness-field__input", textAreaClassName)}
          data-slot="field-textarea"
          {...(placeholder === undefined ? {} : { placeholder })}
          ref={textAreaRef}
        />
      </div>
      <FieldMessages description={description} errorMessage={errorMessage} />
    </AriaTextField>
  );
}

export type SwitchFieldProps = Omit<AriaSwitchFieldProps, "children" | "className"> &
  Readonly<{
    className?: string;
    controlClassName?: string;
    description?: ReactNode;
    errorMessage?: FieldErrorMessage;
    fieldRef?: Ref<HTMLDivElement>;
    label: ReactNode;
  }>;

export function SwitchField({
  className,
  controlClassName,
  description,
  errorMessage,
  fieldRef,
  label,
  ...props
}: SwitchFieldProps) {
  return (
    <AriaSwitchField
      {...props}
      className={classNames("hraness-switch-field", className)}
      data-slot="switch-field"
      ref={fieldRef}
    >
      <AriaSwitchButton
        className={classNames("hraness-switch-field__control", controlClassName)}
        data-slot="switch-control"
      >
        <span
          aria-hidden="true"
          className="hraness-switch-field__track"
          data-slot="switch-track"
        >
          <span className="hraness-switch-field__thumb" data-slot="switch-thumb" />
        </span>
        <span className="hraness-switch-field__label" data-slot="switch-label">
          {label}
        </span>
      </AriaSwitchButton>
      <FieldMessages description={description} errorMessage={errorMessage} />
    </AriaSwitchField>
  );
}

export interface NativeSelectOption<Id extends string> {
  readonly disabled?: boolean;
  readonly id: Id;
  readonly label: string;
}

export type NativeSelectFieldProps<Id extends string> = Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  "children" | "defaultValue" | "onChange" | "size" | "value"
> &
  Readonly<{
    className?: string;
    defaultValue?: Id | "";
    description?: ReactNode;
    errorMessage?: ReactNode;
    isInvalid?: boolean;
    label: ReactNode;
    onChange?: (value: Id, event: ChangeEvent<HTMLSelectElement>) => void;
    options: readonly NativeSelectOption<Id>[];
    placeholder?: string;
    selectClassName?: string;
    selectRef?: Ref<HTMLSelectElement>;
    showLabel?: boolean;
    size?: FieldSize;
    surface?: FieldSurface;
    value?: Id | "";
  }>;

function reportsInvalid(value: AriaAttributes["aria-invalid"]): boolean {
  return value === true
    || value === "true"
    || value === "grammar"
    || value === "spelling";
}

export function NativeSelectField<Id extends string>({
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  className,
  defaultValue,
  description,
  disabled = false,
  errorMessage,
  id,
  isInvalid = false,
  label,
  onChange,
  options,
  placeholder,
  selectClassName,
  selectRef,
  showLabel = true,
  size = "default",
  surface = "default",
  value,
  ...props
}: NativeSelectFieldProps<Id>) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const descriptionId = description === undefined ? undefined : `${controlId}-description`;
  const invalid = isInvalid || reportsInvalid(ariaInvalid);
  const showsError = invalid && errorMessage !== undefined;
  const errorId = showsError ? `${controlId}-error` : undefined;
  const describedBy = [ariaDescribedBy, descriptionId, errorId]
    .filter((candidate): candidate is string => (
      typeof candidate === "string" && candidate.length > 0
    ))
    .join(" ") || undefined;
  const resolvedAriaInvalid = reportsInvalid(ariaInvalid)
    ? ariaInvalid
    : invalid
      ? true
      : ariaInvalid;

  return (
    <div
      className={classNames("hraness-field", "hraness-native-select-field", className)}
      data-disabled={disabled || undefined}
      data-invalid={invalid || undefined}
      data-size={size}
      data-slot="native-select-field"
      data-surface={surface}
    >
      <label
        className={classNames("hraness-field__label", !showLabel && "hraness-visually-hidden")}
        data-slot="field-label"
        htmlFor={controlId}
      >
        {label}
      </label>
      <div className="hraness-field__control" data-slot="field-control">
        <select
          {...props}
          aria-describedby={describedBy}
          aria-invalid={resolvedAriaInvalid}
          className={classNames("hraness-field__select", selectClassName)}
          data-slot="field-select"
          disabled={disabled}
          {...(defaultValue === undefined ? {} : { defaultValue })}
          id={controlId}
          onChange={(event) => {
            const next = options.find((option) => option.id === event.currentTarget.value);
            if (next !== undefined) onChange?.(next.id, event);
          }}
          ref={selectRef}
          {...(value === undefined ? {} : { value })}
        >
          {placeholder === undefined ? null : (
            <option disabled value="">{placeholder}</option>
          )}
          {options.map((option) => (
            <option disabled={option.disabled} key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      {description === undefined ? null : (
        <span
          className="hraness-field__description"
          data-slot="field-description"
          id={descriptionId}
        >
          {description}
        </span>
      )}
      {!showsError ? null : (
        <span
          className="hraness-field__error"
          data-slot="field-error"
          id={errorId}
        >
          {errorMessage}
        </span>
      )}
    </div>
  );
}

type MenuSelectionProps = Pick<
  AriaMenuProps<object>,
  | "defaultSelectedKeys"
  | "disabledKeys"
  | "disallowEmptySelection"
  | "onSelectionChange"
  | "selectedKeys"
  | "selectionMode"
>;

export interface MenuProps extends MenuSelectionProps {
  readonly "aria-label": string;
  readonly children: ReactNode;
  readonly className?: string;
  readonly footer?: ReactNode;
  readonly matchTriggerWidth?: boolean;
  readonly menuRef?: Ref<HTMLDivElement>;
  readonly onAction?: (key: string) => void;
  readonly placement?: Placement;
  readonly popoverClassName?: string;
  readonly shouldCloseOnSelect?: boolean;
}

export function Menu({
  "aria-label": ariaLabel,
  children,
  className,
  defaultSelectedKeys,
  disabledKeys,
  disallowEmptySelection,
  footer,
  matchTriggerWidth = false,
  menuRef,
  onAction,
  onSelectionChange,
  placement = "bottom end",
  popoverClassName,
  selectedKeys,
  selectionMode,
  shouldCloseOnSelect = true,
}: MenuProps) {
  return (
    <AriaPopover
      className={classNames("hraness-menu-popover", popoverClassName)}
      data-match-trigger-width={matchTriggerWidth || undefined}
      data-slot="menu-popover"
      offset={6}
      placement={placement}
      {...(matchTriggerWidth ? { style: { minWidth: "var(--trigger-width)" } } : {})}
    >
      <AriaMenu
        aria-label={ariaLabel}
        className={classNames("hraness-menu", className)}
        data-slot="menu"
        {...(defaultSelectedKeys === undefined ? {} : { defaultSelectedKeys })}
        {...(disabledKeys === undefined ? {} : { disabledKeys })}
        {...(disallowEmptySelection === undefined ? {} : { disallowEmptySelection })}
        {...(onAction === undefined ? {} : { onAction: (key) => onAction(String(key)) })}
        {...(onSelectionChange === undefined ? {} : { onSelectionChange })}
        ref={menuRef}
        {...(selectedKeys === undefined ? {} : { selectedKeys })}
        {...(selectionMode === undefined ? {} : { selectionMode })}
        shouldCloseOnSelect={shouldCloseOnSelect}
      >
        {children}
      </AriaMenu>
      {footer === undefined ? null : (
        <div className="hraness-menu__footer" data-slot="menu-footer">{footer}</div>
      )}
    </AriaPopover>
  );
}

export type MenuItemProps = Omit<
  AriaMenuItemProps,
  "children" | "className" | "id" | "textValue"
> & {
  readonly children: ReactNode;
  readonly className?: string;
  readonly description?: ReactNode;
  readonly id: string;
  readonly leading?: ReactNode;
  readonly shortcut?: ReactNode;
  readonly textValue: string;
  readonly variant?: "danger" | "default";
};

export function MenuItem({
  children,
  className,
  description,
  leading,
  shortcut,
  textValue,
  variant = "default",
  ...props
}: MenuItemProps) {
  return (
    <AriaMenuItem
      {...props}
      className={classNames("hraness-menu__item", className)}
      data-has-description={description === undefined ? undefined : "true"}
      data-slot="menu-item"
      data-variant={variant}
      textValue={textValue}
    >
      {leading === undefined ? null : (
        <span
          aria-hidden="true"
          className="hraness-menu__leading"
          data-slot="menu-item-leading"
        >
          {leading}
        </span>
      )}
      <span className="hraness-menu__copy" data-slot="menu-item-copy">
        <Text className="hraness-menu__label" data-slot="menu-item-label" slot="label">
          {children}
        </Text>
        {description === undefined ? null : (
          <Text
            className="hraness-menu__description"
            data-slot="menu-item-description"
            slot="description"
          >
            {description}
          </Text>
        )}
      </span>
      {shortcut === undefined ? null : (
        <Keyboard className="hraness-menu__shortcut" data-slot="menu-item-shortcut">
          {shortcut}
        </Keyboard>
      )}
    </AriaMenuItem>
  );
}
