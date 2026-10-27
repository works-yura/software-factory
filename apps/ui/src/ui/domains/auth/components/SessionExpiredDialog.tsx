import { AlertDialog } from '@mastra/playground-ui/components/AlertDialog';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';

export function SessionExpiredDialog({ returnTo }: { returnTo: string }) {
  const { t } = useTranslation('auth');
  const navigate = useNavigate();

  return (
    <AlertDialog open>
      <AlertDialog.Content>
        <AlertDialog.Header>
          <AlertDialog.Title>{t('sessionExpired.title')}</AlertDialog.Title>
          <AlertDialog.Description>{t('sessionExpired.description')}</AlertDialog.Description>
        </AlertDialog.Header>
        <AlertDialog.Footer>
          <AlertDialog.Action onClick={() => void navigate(`/signin?returnTo=${encodeURIComponent(returnTo)}`)}>
            {t('sessionExpired.signInAgain')}
          </AlertDialog.Action>
        </AlertDialog.Footer>
      </AlertDialog.Content>
    </AlertDialog>
  );
}
