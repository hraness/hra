export declare const BODY_FONT_STACK = "system-ui, -apple-system, 'Segoe UI', sans-serif";

declare interface Border {
    width: number;
    color: string;
}

export declare function canonicalizeSize(element: Element): void;

export declare function clamp(value: number, min: number, max: number): number;

export declare const DARK: Theme;

export declare const DARK_TOKENS: TokenMap;

export declare const DEFAULT_CONFIG: {
    clickDepthSpring: number;
    clickDepthDamping: number;
    insidePressSpring: number;
    insidePressDamping: number;
    insideLocalBulgeImpulse: number;
    insideLocalHoldBulgeForce: number;
    pressSpring: number;
    pressDamping: number;
    holdPressAmount: number;
    heldCurveSpring: number;
    heldCurveDamping: number;
    insideHeldBulgeAmount: number;
    insideHeldHaloAmount: number;
    insideHeldDepthAmount: number;
    insidePointInfluenceWidth: number;
    insidePointHaloWidth: number;
    insidePointEdgeBoost: number;
    outsideHeldDentAmount: number;
    outsideHeldSideBulgeAmount: number;
    outsideHeldDepthAmount: number;
    normalBlendPasses: number;
    curveTension: number;
    axisDepth: number;
    axisSpring: number;
    axisDamping: number;
    depthImpulse: number;
    depthBulgeImpulse: number;
    depthSpring: number;
    depthDamping: number;
    depthCoupling: number;
    maxDepthIn: number;
    maxDepthOut: number;
    zRotateSpring: number;
    zRotateDamping: number;
    zRotateImpulse: number;
    membraneSpring: number;
    membraneDamping: number;
    waveCoupling: number;
    pressure: number;
    volumeCorrection: number;
    outsideDentImpulse: number;
    outsideSideBulgeImpulse: number;
    outsideOppositeBulgeImpulse: number;
    rippleWidth: number;
    outsideHoldForce: number;
    outsideHoldDepthForce: number;
    maxDent: number;
    maxBulge: number;
    perspective: number;
    samples: number;
};

export declare function emit(element: Element, type: string, detail?: unknown, options?: CustomEventInit): boolean;

export declare const engine: JellyEngine;

export declare function ensureThemeTokens(): void;

export declare function escapeHTML(text: unknown): string;

export declare const FOCUS_RING: {
    color: string;
    width: number;
    gap: number;
    alpha: number;
};

export declare const FONT_STACK = "ui-rounded, 'SF Pro Rounded', system-ui, -apple-system, 'Segoe UI', sans-serif";

export declare function getThemeMode(): ThemeMode;

export declare function horizontalStep(key: string, rtl?: boolean): number;

export declare type IconName = keyof typeof ICONS;

export declare interface IconOptions {
    size?: number;
    label?: string | null;
}

export declare const ICONS: {
    info: string;
    'checkmark-circle': string;
    warning: string;
    'error-circle': string;
    dismiss: string;
    search: string;
    link: string;
    settings: string;
    star: string;
    heart: string;
    'weather-moon': string;
    'weather-sunny': string;
    'theme-auto': string;
};

export declare function inertOutside(el: HTMLElement): () => void;

export declare function integrateSpring(position: number, velocity: number, target: number, stiffness: number, damping: number, dt: number): [number, number];

export declare function isDarkMode(): boolean;

export declare function isRTL(element: Element): boolean;

export declare class JellyBody {
    width: number;
    height: number;
    radius: number;
    config: JellyConfig;
    lean: number;
    leanAmount: number;
    membrane: MembranePoint[];
    state: JellyState;
    baseArea: number;
    constructor({ width, height, radius, config }: JellyBodyOptions);
    resize(width: number, height: number, radius?: number): void;
    sdf(x: number, y: number): number;
    nearestMembraneIndex(x: number, y: number): number;
    addMembraneImpulse(index: number, amount: number, width: number): void;
    addDepthImpulse(index: number, amount: number, width: number): void;
    addInsidePointImpulse(amount: number): void;
    smoothedMembraneValue(index: number, key: 'd' | 'z'): number;
    insidePointInfluence(index: number): {
        local: number;
        halo: number;
    };
    heldMembraneOffsets(index: number): {
        d: number;
        z: number;
    };
    smoothArrayValue(values: number[], index: number): number;
    getSurfacePoints(offset?: number): SurfacePoint[];
    projectPoint(point: SurfacePoint): SurfacePoint;
    updatePressTargets(localX: number, localY: number, influence?: number): {
        insideWeight: number;
    };
    pressAtLocal(localX: number, localY: number, strength?: number, influence?: number): void;
    moveToLocal(localX: number, localY: number, influence?: number): void;
    centerPulse(strength?: number): void;
    centerPop(strength?: number): void;
    stretchAlong(dirX: number, dirY: number, strength?: number): void;
    pulseAt(localX: number, localY: number, strength?: number): void;
    release(): void;
    updateGlobal(dt: number): void;
    updateMembrane(dt: number): void;
    update(dt: number): void;
    recoverIfUnstable(): void;
    isResting(): boolean;
}

export declare interface JellyBodyOptions {
    width: number;
    height: number;
    radius?: number;
    config?: Partial<JellyConfig>;
}

export declare interface JellyComponent {
    frame(dt: number): boolean;
    frameDt?: number;
    colorEasing?: boolean;
}

export declare type JellyConfig = typeof DEFAULT_CONFIG;

export declare class JellyElement extends HTMLElement implements JellyComponent {
    static PAD: number;
    body: JellyBody | null;
    built: boolean;
    dpr: number;
    cssW: number;
    cssH: number;
    config: Partial<JellyConfig> | undefined;
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    resizeObserver: ResizeObserver | null;
    attributeObserver: MutationObserver | null;
    focusVisible: boolean;
    frameDt: number;
    colorEasing: boolean;
    eased: Record<string, RGBA | undefined>;
    probe?: HTMLSpanElement;
    hostFocusTarget?: HTMLElement | null;
    hostFocusHandler?: (event: FocusEvent) => void;
    pressPointerId: number | null;
    keyboardActive: boolean;
    onThemeChange: () => void;
    onWindowResize: () => void;
    constructor();
    styles(): string;
    content(): string;
    shape(width: number, height: number): Shape;
    fill(): string;
    onBuilt(): void;
    onShape(): void;
    frame(dt: number): boolean;
    connectedCallback(): void;
    disconnectedCallback(): void;
    get reducedMotion(): boolean;
    build(): void;
    observeResize(): void;
    jellyBox(): {
        width: number;
        height: number;
        offsetX: number;
        offsetY: number;
        screenX: number;
        screenY: number;
    };
    applyShape(): void;
    reshapeMembrane(): void;
    clearCanvas(): void;
    paintBody(body: JellyBody, options?: PaintOptions): void;
    defaultFrame(dt: number): boolean;
    surfaceBorder(): Border | null;
    focusRing(): Ring | null;
    ringColor(): string;
    easeColor(key: string, expr: string, dt: number): string;
    rgbaTuple(expr: string): RGBA;
    rgbTriple(expr: string): number[];
    colorString([r, g, b, a]: number[], { forceAlpha }?: {
        forceAlpha?: boolean;
    }): string;
    mixColor(from: string, to: string, amount: number): string;
    resolveColor(expr: string): string;
    trackFocus(el: HTMLElement): void;
    useHostFocusTarget(el: HTMLElement | null): void;
    syncHostFocusTarget(): void;
    requestFrame(): void;
    toLocal(clientX: number, clientY: number, body?: JellyBody | null): {
        x: number;
        y: number;
    };
    pressAt(clientX: number, clientY: number, strength?: number): void;
    moveAt(clientX: number, clientY: number): void;
    releaseBody(): void;
    centerPulse(strength?: number): void;
    centerPop(strength?: number): void;
    wirePress(element: HTMLElement, { keyboard, disabled }?: WirePressOptions): void;
}

declare class JellyEngine {
    private active;
    private running;
    private lastTime;
    constructor();
    wake(component: JellyComponent): void;
    drop(component: JellyComponent): void;
    loop(now: number): void;
}

export declare function jellyIcon(name: IconName, { size, label }?: IconOptions): string;

declare interface JellyState {
    clickDepth: number;
    clickDepthV: number;
    targetClickDepth: number;
    insidePress: number;
    insidePressV: number;
    targetInsidePress: number;
    press: number;
    pressV: number;
    targetPress: number;
    insideCurveHold: number;
    insideCurveHoldV: number;
    targetInsideCurveHold: number;
    rotateZ: number;
    rotateZV: number;
    tiltX: number;
    tiltXV: number;
    tiltY: number;
    tiltYV: number;
    targetTiltX: number;
    targetTiltY: number;
    pointerActive: boolean;
    pointerInsideWeight: number;
    pointerIndex: number;
    pointerLocalX: number;
    pointerLocalY: number;
}

export declare function jellyToast(message: string, options?: ToastOptions): HTMLElement;

export declare const LIGHT: Theme;

export declare const LIGHT_TOKENS: TokenMap;

export declare function listNavigate(key: string, index: number, count: number, { rtl, wrap, horizontal, vertical }?: ListNavigateOptions): number;

export declare interface ListNavigateOptions {
    rtl?: boolean;
    wrap?: boolean;
    horizontal?: boolean;
    vertical?: boolean;
}

export declare function lockScroll(): void;

export declare interface MembranePoint {
    x: number;
    y: number;
    nx: number;
    ny: number;
    d: number;
    v: number;
    z: number;
    zv: number;
}

export declare const MONO_FONT_STACK = "ui-monospace, 'SF Mono', Menlo, monospace";

export declare function notifyThemeChange(): void;

export declare function numberAttribute(element: Element, name: string, fallback?: number): number;

export declare function onThemeChange(callback: () => void): () => void;

declare interface PaintOptions {
    fill?: string;
    cx?: number;
    cy?: number;
    alpha?: number;
    ctx?: CanvasRenderingContext2D;
    cssW?: number;
    cssH?: number;
    ring?: Ring | null;
    scaleX?: number;
    scaleY?: number;
    border?: Border | null;
    warp?: ((point: SurfacePoint) => SurfacePoint) | null;
    ease?: boolean;
    easeKey?: string;
}

export declare const PALETTE: TokenMap;

export declare type PhysicalPlacement = 'top' | 'bottom' | 'left' | 'right';

export declare function placeAnchored(anchorEl: HTMLElement, floatEl: HTMLElement, placement?: Placement, gap?: number): PhysicalPlacement;

export declare type Placement = 'top' | 'bottom' | 'left' | 'right' | 'start' | 'end';

export declare interface Point {
    x: number;
    y: number;
}

export declare function portalToBody(el: HTMLElement): () => void;

export declare function prefersReducedMotion(): boolean;

export declare function propagateSize(host: Element, selector: string): void;

export declare function resolvePlacement(placement: Placement, anchorEl: HTMLElement): PhysicalPlacement;

declare type RGBA = [number, number, number, number];

declare interface Ring {
    color: string;
    width: number;
    gap: number;
}

export declare function setThemeMode(mode?: ThemeMode): void;

declare interface Shape {
    width: number;
    height: number;
    radius: number;
}

export declare type Size = 'small' | 'medium' | 'large';

export declare function sizeName(element: Element, fallback?: Size): Size;

export declare function springIn(el: HTMLElement, origin?: string): void;

export declare function springOut(el: HTMLElement, done: () => void): void;

export declare interface SurfacePoint {
    x: number;
    y: number;
    z: number;
}

export declare interface Theme {
    background: {
        default: string;
        surface: string;
        muted: string;
        neutral: string;
        neutralEmphasis: string;
        white: string;
        rose: string;
        amber: string;
        azure: string;
        mint: string;
        accent: string;
    };
    foreground: {
        default: string;
        muted: string;
        onEmphasis: string;
        onNeutral: string;
        onWhite: string;
        onAccent: string;
    };
    border: {
        default: string;
        focus: string;
    };
    shadow: string;
}

export declare type ThemeMode = 'light' | 'dark' | 'auto';

export declare function themeTokenCSS(): string;

export declare function toastIn(el: HTMLElement): void;

declare interface ToastOptions {
    tone?: ToastTone;
    duration?: number;
}

export declare function toastOut(el: HTMLElement, done: () => void): void;

declare type ToastTone = 'info' | 'success' | 'warning' | 'danger';

export declare type TokenMap = Record<string, string>;

export declare function traceSmoothPath(ctx: CanvasRenderingContext2D, points: readonly Point[], tension?: number): void;

export declare function trackAnchor(anchorEl: HTMLElement, floatEl: HTMLElement, placement?: Placement, gap?: number, onHidden?: (() => void) | null): () => void;

export declare function triggerHaptic(duration?: number): void;

export declare function uniqueId(prefix?: string): string;

export declare function unlockScroll(): void;

export declare const VARIANT_CSS: string;

export declare interface VariantColorProps {
    color?: string;
    on?: string | null;
    ring?: string | null;
}

export declare function variantColors({ color, on, ring }?: VariantColorProps): string;

declare interface WirePressOptions {
    keyboard?: boolean;
    disabled?: () => boolean;
}

export { }
