import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { ORG_PROFILE_STORAGE_KEY } from './lib/storage';
import type { OrganizationProfile } from './types/organization';

const savedProfile: OrganizationProfile = {
  id: 'profile-1',
  name: 'Bright Futures Center',
  mission: 'Help students thrive.',
  focusAreas: ['education'],
  focusAreasOther: '',
  whoWeServe: 'First-generation students',
  geographicArea: 'Austin, Texas',
  annualBudgetRange: '$50k-$250k',
  organizationType: 'nonprofit',
  updatedAt: '2026-08-17T12:00:00.000Z',
};

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('organization profile setup flow', () => {
  it('shows the warm first-run screen and opens the setup form', async () => {
    render(<App />);

    expect(await screen.findByText('Welcome to GrantFlow.')).toBeTruthy();
    const startButton = screen.getByRole('button', { name: 'Set up your organization' });

    fireEvent.click(startButton);

    expect(await screen.findByRole('heading', { name: 'Tell us what you want GrantFlow to remember.' })).toBeTruthy();
    expect(screen.getByLabelText('Organization name')).toBeTruthy();
  });

  it('saves even when every field is blank, then shows the confirmation and summary card', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Set up your organization' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));

    expect(await screen.findByText("Saved. We'll use this to find grants that fit you.")).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Organization profile' })).toBeTruthy();
    expect(screen.getByText('You saved your organization profile. Add details anytime when you are ready.')).toBeTruthy();

    const stored = JSON.parse(window.localStorage.getItem(ORG_PROFILE_STORAGE_KEY) || 'null') as OrganizationProfile | null;
    expect(stored?.id).toBeTruthy();
    expect(stored?.name).toBe('');
  });

  it('shows a saved profile on return and lets the person edit pre-filled details', async () => {
    window.localStorage.setItem(ORG_PROFILE_STORAGE_KEY, JSON.stringify(savedProfile));

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Bright Futures Center' })).toBeTruthy();
    expect(screen.getByText('Help students thrive.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    expect(await screen.findByDisplayValue('Bright Futures Center')).toBeTruthy();
    expect(screen.getByDisplayValue('Austin, Texas')).toBeTruthy();
  });

  it('keeps typed details on screen and shows a plain retry message when saving fails', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage is unavailable');
    });

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Set up your organization' }));
    const nameInput = await screen.findByLabelText('Organization name');
    fireEvent.change(nameInput, { target: { value: 'Community Kitchen' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText("We couldn't save your changes. Please try again.")).toBeTruthy();
    expect(screen.getByDisplayValue('Community Kitchen')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Community Kitchen' })).toBeNull();
  });

  it('shows the welcome screen instead of breaking when saved data is not readable', async () => {
    window.localStorage.setItem(ORG_PROFILE_STORAGE_KEY, '{not valid json');

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Welcome to GrantFlow.')).toBeTruthy();
    });
  });
});
