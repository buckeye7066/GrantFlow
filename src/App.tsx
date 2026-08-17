import { useState } from 'react';
import { useOrgProfile } from './store/orgProfile';
import { OrganizationProfile } from './types/organization';
import Welcome from './components/Welcome';
import OrgProfileForm from './components/OrgProfileForm';
import OrgProfileCard from './components/OrgProfileCard';
import Notice from './components/Notice';

type View = 'welcome' | 'form' | 'card';

export default function App() {
  const { profile, isLoaded, save } = useOrgProfile();
  const [editing, setEditing] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [saveError, setSaveError] = useState('');

  // Decide what to show. While the saved data is still loading, show a calm
  // blank so the welcome screen never flashes before the card on return visits.
  let view: View;
  if (editing) {
    view = 'form';
  } else if (profile) {
    view = 'card';
  } else {
    view = 'welcome';
  }

  function handleSave(values: Partial<OrganizationProfile>) {
    const result = save(values);
    if (result.ok) {
      setSaveError('');
      setConfirmation("Saved. We'll use this to find grants that fit you.");
      setEditing(false);
    } else {
      // Keep the user on the form with their typed data intact.
      setConfirmation('');
      setSaveError("We couldn't save your changes. Please try again.");
    }
  }

  function startSetup() {
    setConfirmation('');
    setSaveError('');
    setEditing(true);
  }

  function cancelEdit() {
    setSaveError('');
    setEditing(false);
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <main className="mx-auto max-w-3xl px-4 py-10 sm:py-16">
        {(confirmation || saveError) && (
          <div className="mb-6">
            {confirmation && (
              <Notice
                kind="success"
                message={confirmation}
                onDismiss={() => setConfirmation('')}
              />
            )}
            {saveError && <Notice kind="problem" message={saveError} />}
          </div>
        )}

        {!isLoaded ? (
          <div className="py-20 text-center text-base text-slate-600">Loading&hellip;</div>
        ) : view === 'welcome' ? (
          <Welcome onStart={startSetup} />
        ) : view === 'form' ? (
          <OrgProfileForm initial={profile} onSave={handleSave} onCancel={cancelEdit} />
        ) : profile ? (
          <OrgProfileCard profile={profile} onEdit={startSetup} />
        ) : null}
      </main>
    </div>
  );
}
