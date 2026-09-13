export function updateMetaTags({
  title,
  description,
  image,
}: {
  title?: string;
  description?: string;
  image?: string;
}) {
  const fullTitle = title ? `${title} — Hikkomanga` : 'Hikkomanga — Читалка манги онлайн';
  document.title = fullTitle;

  const setMeta = (name: string, content: string) => {
    let element = document.querySelector(`meta[name="${name}"]`) || document.querySelector(`meta[property="${name}"]`);
    if (!element) {
      element = document.createElement('meta');
      if (name.startsWith('og:')) {
        element.setAttribute('property', name);
      } else {
        element.setAttribute('name', name);
      }
      document.head.appendChild(element);
    }
    element.setAttribute('content', content);
  };

  if (description) {
    setMeta('description', description);
    setMeta('og:description', description);
  }
  setMeta('og:title', fullTitle);
  if (image) {
    setMeta('og:image', image);
  }
}
