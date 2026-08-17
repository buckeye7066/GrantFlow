type WelcomeProps = {
  onStart: () => void;
};

// First thing a new user sees: one warm line and one big obvious button.
// No instructions, no jargon.
export default function Welcome({ onStart }: WelcomeProps) {
  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center px-6 text-center">
      <h1 className="max-w-2xl text-3xl font-bold text-slate-900 sm:text-4xl">
        Welcome to GrantFlow
      </h1>
      <p className="mt-4 max-w-xl text-lg text-slate-700">
        Tell us a little about your organization, and we&rsquo;ll help find grants that fit you.
      </p>
      <button
        type="button"
        onClick={onStart}
        className="mt-10 rounded-2xl bg-emerald-700 px-10 py-5 text-xl font-semibold text-white shadow-lg transition hover:bg-emerald-800 focus:outline-none focus:ring-4 focus:ring-emerald-300"
      >
        Set up your organization
      </button>
      <p className="mt-8 max-w-md text-sm text-slate-600">
        Your information stays on this device. No account and no internet needed.
      </p>
    </div>
  );
}
