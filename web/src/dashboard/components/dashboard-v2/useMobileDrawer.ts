import { useCallback, useEffect, useRef, useState, type PointerEvent, type TouchEvent, type UIEvent, type WheelEvent, type FocusEvent } from 'react';

export function useMobileDrawer() {
    const [position, setPosition] = useState<'peek' | 'expanded' | 'dismissed'>('peek');
    const expanded = position === 'expanded';
    const dismissed = position === 'dismissed';
    const [viewportHeight, setViewportHeight] = useState<number>();
    useEffect(() => {
        const viewport = window.visualViewport;
        if (!viewport) return;
        const resize = () => { if (viewport.scale === 1) setViewportHeight(viewport.height); };
        resize();
        viewport.addEventListener('resize', resize);
        return () => viewport.removeEventListener('resize', resize);
    }, []);
    const scrollRef = useRef<HTMLDivElement>(null);
    const touch = useRef<{ y: number; top: number } | null>(null);
    const handleY = useRef<number | null>(null);
    const dragged = useRef(false);
    const showDetails = useCallback(() => setPosition('expanded'), []);
    const showMap = useCallback(() => {
        setPosition('peek');
        scrollRef.current?.scrollTo({ top: 0, behavior: 'instant' });
    }, []);
    const dismiss = useCallback(() => {
        setPosition('dismissed');
        scrollRef.current?.scrollTo({ top: 0, behavior: 'instant' });
    }, []);
    const toggle = () => {
        if (dragged.current) { dragged.current = false; return; }
        if (dismissed || expanded) showMap(); else showDetails();
    };
    return {
        expanded, dismissed, viewportHeight, scrollRef, showMap, showDetails, toggle,
        scrollEvents: {
            onScroll: (event: UIEvent<HTMLDivElement>) => {
                if (event.currentTarget.scrollTop > 16) showDetails();
            },
            onTouchStart: (event: TouchEvent<HTMLDivElement>) => {
                touch.current = event.touches.length === 1 ? { y: event.touches[0].clientY, top: event.currentTarget.scrollTop } : null;
            },
            onTouchEnd: (event: TouchEvent<HTMLDivElement>) => {
                if (!touch.current || !event.changedTouches.length) return;
                const delta = event.changedTouches[0].clientY - touch.current.y;
                if (delta > 60 && touch.current.top <= 0) dismiss();
                else if (delta < -35) showDetails();
                touch.current = null;
            },
            onWheel: (event: WheelEvent<HTMLDivElement>) => {
                if (event.deltaY < -12 && event.currentTarget.scrollTop <= 0) showMap();
                else if (event.deltaY > 12) showDetails();
            },
            onFocusCapture: (event: FocusEvent<HTMLDivElement>) => {
                if (event.target.matches('input, textarea, select')) showDetails();
            },
        },
        handleEvents: {
            onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
                handleY.current = event.clientY;
                dragged.current = false;
                event.currentTarget.setPointerCapture(event.pointerId);
            },
            onPointerUp: (event: PointerEvent<HTMLButtonElement>) => {
                if (handleY.current === null) return;
                const delta = event.clientY - handleY.current;
                dragged.current = Math.abs(delta) > 24;
                if (delta < -24) showDetails(); else if (delta > 24) dismiss();
                handleY.current = null;
            },
            onPointerCancel: () => { handleY.current = null; dragged.current = false; },
        },
    };
}
