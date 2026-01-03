import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import EmailSignInForm from './EmailSignInForm'

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
      <TabsList className="grid w-full grid-cols-1">
        <TabsTrigger value="email">Email</TabsTrigger>
      </TabsList>

      <TabsContent value="email" className="mt-6">
        <EmailSignInForm onComplete={onComplete} />
      </TabsContent>
    </Tabs>
  )
}
