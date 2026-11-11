import { useState } from 'react';
import { t } from './i18n/index.js';
import type { WorkspaceError } from './useWorkspace.js';

const UPDATE_COMMAND = 'npx agent-workbench@latest';

export function StartupErrorBanner({ error, agent, onClose }: {
  error: WorkspaceError; agent: string; onClose: () => void;
}) {
  const [copyFailed, setCopyFailed] = useState(false);
  const startup = error.startup;
  return <div className="banner banner-error startup-error" role="alert">
    <div className="startup-error-content">
      <div>{startup ? t('startup.failed', { agent }) : error.message}</div>
      {startup && <>
        <p>{t('startup.advice')}</p>
        <button onClick={() => { onClose(); startup.retry(); }}>{t('startup.retry')}</button>
      </>}
      <details>
        <summary>{t('startup.details')}</summary>
        <pre>{error.detail ?? error.message}</pre>
        <button onClick={async () => {
          try {
            await navigator.clipboard.writeText(error.detail ?? error.message);
            setCopyFailed(false);
          } catch {
            setCopyFailed(true);
          }
        }}>{t('startup.copy')}</button>
        {copyFailed && <p>{t('startup.copyFailed')}</p>}
      </details>
      {startup && <details>
        <summary>{t('startup.update')}</summary>
        <p>{t('startup.cliHelp', { agent })}</p>
        <p>{t('startup.awbHelp')}</p>
        <code>{UPDATE_COMMAND}</code>
        <p>{t('startup.afterUpdate')}</p>
      </details>}
    </div>
    <button className="banner-close" onClick={onClose} title={t('common.close')}>×</button>
  </div>;
}
