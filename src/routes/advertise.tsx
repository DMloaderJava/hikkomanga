import { createFileRoute } from '@tanstack/react-router';
import { RequestForm } from '@/components/admin/RequestForm';
import { Megaphone } from 'lucide-react';
import { useEffect } from 'react';
import { updateMetaTags, seoForRoute } from '@/lib/seo';

export const Route = createFileRoute('/advertise')({
  component: AdvertisePage,
});

function AdvertisePage() {
  useEffect(() => {
    updateMetaTags(seoForRoute(Route.id));
  }, []);

  return (
    <main className="mx-auto max-w-lg px-4 py-12 space-y-8">
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-rose-950/60 text-rose-400">
            <Megaphone className="h-5 w-5" />
          </div>
          <h1 className="text-2xl font-bold text-white">Реклама на Hikkomanga</h1>
        </div>
        <p className="text-sm text-neutral-400 leading-relaxed">
          Ваш баннер увидят активные читатели манги между главами. Заявки
          рассматриваются в течение 48 часов — владелец свяжется для обсуждения
          условий и оплаты.
        </p>
      </div>

      <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
        <RequestForm
          type="ad_request"
          title="Заявка на размещение рекламы"
          description="Опишите ваш продукт или сервис, желаемый срок размещения и контакт для связи. Мы свяжемся с вами в течение 48 часов."
          submitLabel="Отправить заявку"
        />
      </div>
    </main>
  );
}
