import { useEffect, useState } from 'react';
import { forecastRequests, type ForecastData } from '@/lib/telemetry/forecastRequests';

export function useFleetProjections(ids: string[]) {
    const [forecasts, setForecasts] = useState<Record<string, ForecastData>>({});
    const key = JSON.stringify([...ids].sort());
    useEffect(() => {
        const stops = (JSON.parse(key) as string[]).map(id => forecastRequests.watch(id, result => {
            if (result.status === 200 && result.data) setForecasts(current => ({ ...current, [id]: result.data! }));
        }, false, 'position'));
        return () => stops.forEach(stop => stop());
    }, [key]);
    return forecasts;
}
