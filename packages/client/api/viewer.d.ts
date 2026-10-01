import { TouchDispatchType, TouchPoint, KeyEvent, GlassStats, InteractiveElement, NavigationState, GlassClient } from '../index.js';

interface GamepadButtonMapping {
    leftClick: number[];
    rightClick: number[];
    dpadUp: number;
    dpadDown: number;
    dpadLeft: number;
    dpadRight: number;
    enter: number;
    escape: number;
}
interface GamepadAxisMapping {
    cursorX: number;
    cursorY: number;
    scrollX: number;
    scrollY: number;
}
interface GamepadMapping {
    deadZone: number;
    cursorSensitivity: number;
    scrollSensitivity: number;
    buttons: GamepadButtonMapping;
    axes: GamepadAxisMapping;
}
declare const DEFAULT_GAMEPAD_MAPPING: GamepadMapping;
declare function applyStickCurve(raw: number, deadZone: number): number;
interface GamepadInputGeometry {
    getVideoSize: () => {
        width: number;
        height: number;
    } | null;
}
interface GamepadInputCallbacks {
    onCursorMove: (x: number, y: number, dragging: boolean) => void;
    onMouseDown: (x: number, y: number, button: "left" | "right") => void;
    onMouseUp: (x: number, y: number, button: "left" | "right") => void;
    onScroll: (deltaY: number, deltaX: number) => void;
    onKeyDown: (key: string, code: string) => void;
    onKeyUp: (key: string, code: string) => void;
}
declare class GamepadInputController {
    constructor(geometry: GamepadInputGeometry, callbacks: GamepadInputCallbacks, mapping?: Partial<GamepadMapping>);
    attach(): () => void;
}

declare function clientToVideoPoint(clientX: number, clientY: number, containerRect: DOMRect, videoWidth: number, videoHeight: number): {
    x: number;
    y: number;
} | null;
interface TouchInputGeometry {
    getContainerRect: () => DOMRect | null;
    getVideoSize: () => {
        width: number;
        height: number;
    } | null;
}
interface TouchInputCallbacks {
    onTouchPoints: (type: TouchDispatchType, points: TouchPoint[], gestureId: number, moveCount?: number) => void;
    onTap?: (point: {
        x: number;
        y: number;
    } | null) => void;
}
declare class TouchInputController {
    constructor(geometry: TouchInputGeometry, callbacks: TouchInputCallbacks);
    attach(el: HTMLElement): () => void;
}

interface KeyboardTarget {
    isConnected(): boolean;
    pasteText(text: string): void;
    dispatchKeyEvent(event: KeyEvent): void;
    getStats(): Promise<GlassStats | null>;
}
declare class MobileKeyboardController {
    constructor(container: HTMLElement, target: KeyboardTarget, enabled: boolean);
    handleTap: (point: {
        x: number;
        y: number;
    } | null) => void;
    setRttMs(ms: number | null): void;
    setInteractiveElements(elements: InteractiveElement[]): void;
    setEditableFocused(value: boolean): void;
    destroy(): void;
}

interface GlassViewerOptions {
    onNavigation?: (nav: NavigationState) => void;
    onContextMenu?: (x: number, y: number, shiftKey: boolean) => void;
    isMobile?: boolean;
    captureKeyboard?: boolean;
    gamepadMapping?: Partial<GamepadMapping>;
}
interface GlassViewer {
    readonly video: HTMLVideoElement;
    destroy(): void;
}
declare function mountGlassViewer(container: HTMLElement, client: GlassClient, options?: GlassViewerOptions): GlassViewer;

export {
    DEFAULT_GAMEPAD_MAPPING,
    type GamepadAxisMapping,
    type GamepadButtonMapping,
    GamepadInputController,
    type GamepadInputGeometry,
    type GamepadMapping,
    type GlassViewer,
    type GlassViewerOptions,
    MobileKeyboardController,
    TouchInputController,
    type TouchInputGeometry,
    applyStickCurve,
    clientToVideoPoint,
    mountGlassViewer,
};
