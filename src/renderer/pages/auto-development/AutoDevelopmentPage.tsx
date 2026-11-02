import { HomeCards } from '../assistant/HomeCards';

export function AutoDevelopmentPage() {
  return <div className="h-full overflow-y-auto px-6 py-8">
    <div className="mx-auto max-w-[860px]">
      <HomeCards onSend={() => {}} autoDevelopmentOnly />
    </div>
  </div>;
}
