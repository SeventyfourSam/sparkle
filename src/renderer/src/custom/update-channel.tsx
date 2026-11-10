import { Tabs } from '@heroui/react'

export function releaseChannelOptions() {
  return (
    <Tabs.Tab key="stable" id="stable">
      正式版
      <Tabs.Indicator />
    </Tabs.Tab>
  )
}
