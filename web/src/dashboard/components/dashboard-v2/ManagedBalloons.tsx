import { useEffect, useId, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronRight, faDownload, faChartLine } from '@fortawesome/free-solid-svg-icons';
import { useCommunity } from './community-account';
import { ManagedBalloon } from './CommunityPanel';
import { BalloonOwner, OfficialBadge } from './BalloonIdentity';
import { balloonName } from '@/lib/telemetry/fleetPlayback';
import { FULL_TELEMETRY_COLUMNS } from './useTelemetry';
import { fetchTelemetryMerged } from '@/lib/telemetry/fetchMergedTelemetry';
import { createClient } from '@/lib/supabase';
import { telemetryCsv } from '@/lib/telemetry/telemetryCsv';
import type { RegisteredBalloon } from '@/lib/community/types';

export default function ManagedBalloons({ onView }: { onView: (id: string) => void }) {
    const community = useCommunity();
    const [expanded, setExpanded] = useState<string | null>(community.focusDevice);
    useEffect(() => { setExpanded(community.focusDevice); }, [community.focusDevice]);
    return <section className="fleet-cards managed-list" aria-label="Your balloons">
        <div className="managed-list-heading"><h1>Your balloons</h1><span>{community.balloons.length}</span></div>
        {community.balloons.map(balloon => <ManagedCard key={balloon.id} balloon={balloon}
            open={expanded === balloon.id} onToggle={() => setExpanded(current => current === balloon.id ? null : balloon.id)} onView={onView} />)}
        {!community.balloons.length && <p className="fleet-message">No balloons registered yet.</p>}
        <div className="managed-register-row"><button className="dashboard-register" onClick={() => community.setPanel('register')}>Register a balloon</button></div>
    </section>;
}

function ManagedCard({ balloon, open, onToggle, onView }: {
    balloon: RegisteredBalloon; open: boolean; onToggle: () => void; onView: (id: string) => void;
}) {
    const id = useId();
    const [downloading, setDownloading] = useState(false);
    const [notice, setNotice] = useState('');
    const regions = new Set(balloon.connections.map(connection => connection.region || connection.cluster));
    const date = balloon.launchedAt ? new Date(balloon.launchedAt) : balloon.plannedLaunchDate ? new Date(balloon.plannedLaunchDate + 'T12:00:00') : null;
    async function download() {
        setDownloading(true); setNotice('');
        try {
            const rows = await fetchTelemetryMerged(createClient(), {
                deviceId: balloon.id, since: '1970-01-01T00:00:00.000Z', columns: FULL_TELEMETRY_COLUMNS,
            });
            if (!rows.length) { setNotice('No telemetry to download yet.'); return; }
            const blob = new Blob([telemetryCsv(rows)], { type: 'text/csv;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url; link.download = balloon.id.replace(/[^a-zA-Z0-9_-]/g, '-') + '-telemetry.csv';
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            setNotice(rows.length.toLocaleString() + ' packets downloaded.');
        } catch { setNotice('Unable to download telemetry. Please try again.'); }
        finally { setDownloading(false); }
    }
    return <article className="balloon-card managed-card" data-open={open}>
        <button className="managed-card-toggle" aria-expanded={open} aria-controls={id} onClick={onToggle}>
            <span className="balloon-card-heading"><span className="balloon-card-name"><span className="balloon-card-title">{balloonName(balloon)}</span><OfficialBadge official={balloon.official} /></span><FontAwesomeIcon className="balloon-card-chevron" icon={faChevronRight} /></span>
            <span className="balloon-byline"><BalloonOwner device={{ official: balloon.official, ownerGithub: balloon.ownerGithub ?? undefined }} link={false} /><span className="managed-status">{balloon.status}</span></span>
            <span className="managed-card-details">
                <span><small>{balloon.launchedAt ? 'Launched' : 'Planned launch'}</small>{date ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'Not set'}</span>
                <span><small>Networks</small>{regions.size || 'Not connected'}</span>
            </span>
        </button>
        <div className="managed-card-reveal" id={id} inert={!open}><div>
            <div className="managed-card-content">
                <ManagedBalloon balloon={balloon} />
                <div className="managed-data-actions">
                    <button onClick={() => onView(balloon.id)}><FontAwesomeIcon icon={faChartLine} />View telemetry</button>
                    <button disabled={downloading} onClick={() => void download()}><FontAwesomeIcon icon={faDownload} />{downloading ? 'Downloading…' : 'Download CSV'}</button>
                </div>
                {notice && <p className="managed-notice" role="status">{notice}</p>}
            </div>
        </div></div>
    </article>;
}
