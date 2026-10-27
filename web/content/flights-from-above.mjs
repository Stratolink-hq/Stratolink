import { readFileSync } from 'node:fs';

const body = readFileSync(new URL('./articles/flights-from-above.html', import.meta.url), 'utf8');

export const flightsFromAboveArticle = {
  slug: 'flights-from-above',
  title: 'Flights from a satellite view',
  category: 'Flight notes',
  excerpt: 'Our balloons’ flights laid over the satellite pictures taken while they flew: Stratolink 1’s afternoon down the California coast, and Stratolink 3’s first days, from San Francisco to New Mexico.',
  published: '2026-10',
  publishedLabel: 'October 2026',
  author: { name: 'Caleb Kruse', github: 'https://github.com/clkruse' },
  image: {
    src: '/assets/blog/stratolink-1-coast.jpg',
    alt: 'A wide satellite view of the California coast and the Pacific, with Stratolink 1’s yellow track running south from San Francisco past Monterey Bay to its last GPS fix off Big Sur, then a dashed estimate and a fan of faint blue possible paths over the ocean.',
    width: 2400,
    height: 1500,
    position: '48% 40%',
    caption: 'Stratolink 1 on October 23, 2026.',
  },
  showHero: false,
  interactive: 'flight-figure',
  styles: ['/payload-dev-log/article.css', '/flight-figure/figure.css'],
  body,
};
