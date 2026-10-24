import { useId, useRef, useState, type CSSProperties } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faEllipsis } from '@fortawesome/free-solid-svg-icons';
import { useCommunity } from './community-account';
import { useDashboardTheme } from './dashboard-theme';

export default function BalloonActions({ deviceId }: { deviceId: string }) {
    const community = useCommunity();
    const { theme } = useDashboardTheme();
    const balloon = community.balloons.find(item => item.id === deviceId);
    const id = useId();
    const menu = useRef<HTMLDivElement>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    const [position, setPosition] = useState({ top: 0, right: 0 });
    const [error, setError] = useState('');
    if (!community.account || !balloon) return null;
    return <div className="balloon-actions">
        <button ref={trigger} className="balloon-actions-trigger" popoverTarget={id} aria-label={'Manage ' + balloon.callsign} aria-haspopup="dialog">
            <FontAwesomeIcon icon={faEllipsis} />
        </button>
        <div ref={menu} id={id} popover="auto" role="dialog" aria-label={'Manage ' + balloon.callsign}
            className="dashboard-menu balloon-actions-menu" data-theme={theme}
            style={{ '--menu-top': position.top + 'px', '--menu-right': position.right + 'px' } as CSSProperties}
            onBeforeToggle={event => { if (event.newState === 'open') {
                const rect = trigger.current!.getBoundingClientRect();
                setPosition({ top: rect.bottom + 8, right: Math.max(12, window.innerWidth - rect.right) });
                setError('');
            } }}>
            <button className="balloon-manage-link" onClick={() => { menu.current?.hidePopover(); community.managePayload(deviceId); }}>Manage balloon</button>
            <label className="community-field">Flight status<select value={balloon.status} disabled={community.busy} onChange={async event => {
                setError('');
                try { await community.update(deviceId, event.target.value); menu.current?.hidePopover(); }
                catch (error) { setError(error instanceof Error ? error.message : 'Unable to update status.'); }
            }}>{['planned', 'flying', 'landed', 'missing', 'retired'].map(status => <option key={status} value={status}>{status[0].toUpperCase() + status.slice(1)}</option>)}</select></label>
            {error && <p className="community-error" role="alert">{error}</p>}
        </div>
    </div>;
}
