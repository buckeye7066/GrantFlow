import EmailSignInForm from './EmailSignInForm'

export default function AuthMethodTabs({
  onComplete,
}) {
  return (
    <Tabs {...tabsProps} className="w-full">
      <TabsList className="grid w-full grid-cols-1">
        <TabsTrigger value="email">Email</TabsTrigger>
      </TabsList>

      <TabsContent value="email" className="mt-6">
        <EmailSignInForm onComplete={onComplete} />
      </TabsContent>
    </Tabs>
    <div className="w-full">
      <EmailSignInForm onComplete={onComplete} />
    </div>
  )
}
