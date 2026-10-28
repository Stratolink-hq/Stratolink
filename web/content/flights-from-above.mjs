import { readFileSync } from 'node:fs';

const body = readFileSync(new URL('./articles/flights-from-above.html', import.meta.url), 'utf8');

export const flightsFromAboveArticle = {
  slug: 'flights-from-above',
  title: 'Flights from a satellite view',
  category: 'Flight notes',
  excerpt: 'Our balloons’ flights laid over the satellite pictures taken while they flew: Stratolink 3 from San Francisco past Baja to New Mexico, and later over Spain, and Stratolink 1’s afternoon down the California coast.',
  published: '2026-10',
  publishedLabel: 'October 2026',
  author: { name: 'Caleb Kruse', github: 'https://github.com/clkruse' },
  image: {
    src: '/assets/blog/stratolink-3-southwest.jpg',
    alt: 'A satellite view of the American Southwest and northern Mexico at midday, with Stratolink 3’s yellow track running south from San Francisco along the coast and past Baja over a field of cloud, then turning northeast across the Gulf of California and Sonora to New Mexico.',
    width: 2400,
    height: 1500,
    position: '40% 50%',
    caption: 'Stratolink 3, May 17 to 19, 2026.',
  },
  showHero: false,
  interactive: 'flight-figure',
  styles: ['/payload-dev-log/article.css', '/flight-figure/figure.css'],
  body,
};
