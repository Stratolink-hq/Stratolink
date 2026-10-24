import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/* Telemetry is stored metric (altitude m, distance km, temperature °C) and
 * every series and threshold stays metric; this setting only changes how a
 * value is displayed. Pick the system in the dashboard menu. */
export type UnitSystem = 'metric' | 'imperial';

const STORAGE_KEY = 'stratolink-dashboard-units';
const FEET_PER_METER = 3.280839895;
const MILES_PER_KM = 0.621371192;

export const UNIT_LABELS: Record<UnitSystem, { altitude: string; distance: string; temperature: string; speed: string }> = {
    metric: { altitude: 'm', distance: 'km', temperature: '°C', speed: 'km/h' },
    imperial: { altitude: 'ft', distance: 'mi', temperature: '°F', speed: 'mph' },
};

function readStoredUnits(): UnitSystem {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored === 'metric' || stored === 'imperial') return stored;
    } catch { /* Default when storage is unavailable. */ }
    return 'metric';
}

type DashboardUnitsContextValue = {
    units: UnitSystem;
    setUnits: (units: UnitSystem) => void;
};

const DashboardUnitsContext = createContext<DashboardUnitsContextValue | null>(null);

export function DashboardUnitsProvider({ children }: { children: ReactNode }) {
    const [units, setUnitsState] = useState<UnitSystem>(readStoredUnits);

    useEffect(() => {
        /* Follow a choice made in another tab (the homepage globe and the full dashboard are separate documents). */
        const onStorage = (event: StorageEvent) => {
            if (event.key === STORAGE_KEY || event.key === null) setUnitsState(readStoredUnits());
        };
        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
    }, []);

    const setUnits = useCallback((next: UnitSystem) => {
        setUnitsState(next);
        try { localStorage.setItem(STORAGE_KEY, next); } catch { /* Keep the session usable. */ }
    }, []);

    const value = useMemo(() => ({ units, setUnits }), [units, setUnits]);
    return <DashboardUnitsContext.Provider value={value}>{children}</DashboardUnitsContext.Provider>;
}

/* Converters from the stored metric value to the chosen system. Each passes
 * null/NaN through so callers keep their own '-' handling. */
export function useUnits() {
    const ctx = useContext(DashboardUnitsContext);
    if (!ctx) throw new Error('useUnits must be used within DashboardUnitsProvider');
    const { units, setUnits } = ctx;
    return useMemo(() => {
        const imperial = units === 'imperial';
        const convert = (f: (v: number) => number) => <T extends number | null | undefined>(v: T): T extends number ? number : T =>
            (v == null || !Number.isFinite(v) ? v : f(v)) as T extends number ? number : T;
        return {
            units,
            setUnits,
            labels: UNIT_LABELS[units],
            /** metres → m or ft */
            altitude: convert(m => imperial ? m * FEET_PER_METER : m),
            /** kilometres → km or mi */
            distance: convert(km => imperial ? km * MILES_PER_KM : km),
            /** °C → °C or °F */
            temperature: convert(c => imperial ? c * 9 / 5 + 32 : c),
            /** km/h → km/h or mph */
            speed: convert(kmh => imperial ? kmh * MILES_PER_KM : kmh),
        };
    }, [units, setUnits]);
}
