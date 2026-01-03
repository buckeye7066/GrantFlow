import EmailSignInForm from './EmailSignInForm'

export default function AuthMethodTabs({
  onComplete,
}) {
  return (
    <div className="w-full">
      <EmailSignInForm onComplete={onComplete} />
    </div>
  )
}
