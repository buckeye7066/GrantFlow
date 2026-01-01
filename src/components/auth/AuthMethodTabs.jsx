import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import EmailSignInForm from './EmailSignInForm'
import PhoneSignInForm from './PhoneSignInForm'
import SocialSignInButtons from './SocialSignInButtons'

export default function AuthMethodTabs({
  defaultTab = 'email',
  value,
  onValueChange,
  onComplete,
}) {
  const tabsProps =
    value !== undefined
      ? {
          value,
          onValueChange,
        }
      : {
          defaultValue: defaultTab,
        }

  return (
    <Tabs {...tabsProps} className="w-full">
      <TabsList className="grid w-full grid-cols-3">
        <TabsTrigger value="email">Email</TabsTrigger>
        <TabsTrigger value="phone">Phone</TabsTrigger>
        <TabsTrigger value="social">Social</TabsTrigger>
      </TabsList>

      <TabsContent value="email" className="mt-6">
        <EmailSignInForm onComplete={onComplete} />
      </TabsContent>

      <TabsContent value="phone" className="mt-6">
        <PhoneSignInForm onComplete={onComplete} />
      </TabsContent>

      <TabsContent value="social" className="mt-6">
        <SocialSignInButtons onComplete={onComplete} />
      </TabsContent>
    </Tabs>
  )
}
