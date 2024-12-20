import { type Metadata } from 'next'
import Image from 'next/image'

import { BookCard } from '@/components/BookCard'
import { SimpleLayout } from '@/components/SimpleLayout'
import imageMeditations from '@/images/photos/meditations-abstract.png'
import imageShannon from '@/images/photos/shannon-abstract.png'
import imageAstrophysics from '@/images/photos/astrophysics-abstract.png'
import imageExpeditionaryForce from '@/images/photos/expeditionary-force.png'
import imageProjectHailMary from '@/images/photos/project-hail-mary.png'
import imageSapiens from '@/images/photos/sapiens.png'
import imageHalfLifeOfMarieCurie from '@/images/photos/marie-curie.png'
import imageNexus from '@/images/photos/creation-of-adam.png'

const books = [
  {
    name: 'A Mathematical Theory of Communication',
    author: 'C. Shannon',
    description:
      'In this foundational 1948 paper, Claude Shannon made significant contributions to the fied of information theory.',
    link: {
      href: 'https://people.math.harvard.edu/~ctm/home/text/others/shannon/entropy/entropy.pdf',
      label: 'Harvard University',
    },
    image: imageShannon,
  },
  {
    name: 'Meditations',
    author: 'Marcus Aurelius',
    description:
      'A series of personal writings by Marcus Aurelius, Roman Emperor from 161 to 180 AD, recording his private notes to himself and ideas on Stoic philosophy.',
    link: {
      href: 'https://www.amazon.com/gp/product/0812968255/ref=ppx_yo_dt_b_search_asin_image?ie=UTF8&psc=1',
      label: 'Amazon',
    },
    image: imageMeditations,
  },
  {
    name: 'Astrophysics for People in a Hurry',
    author: 'Neil deGrasse Tyson',
    description:
      "What is the nature of space and time? There's no better guide through these mind-expanding questions than Neil.",
    link: {
      href: "https://www.audible.com/pd/Astrophysics-for-People-in-a-Hurry-Audiobook/B06X9MXN32?source_code=ASSGB149080119000H&share_location=pdp",
      label: 'Audible',
    },
    image: imageAstrophysics,
  },
  {
    name: 'Expeditionary Force',
    author: 'Craig Alanson, Voice by R.C. Bray',
    description:
      'The series follows Bishop, a US soldier sent to space to fight aliens  that invaded Earth. Along the way, he meets Skippy, a "smart" Elder AI, and together they embark on missions to save humanity.',
    link: {
      href: 'https://www.audible.com/series/Expeditionary-Force-Audiobooks/B01N9CUGHG',
      label: 'Audible',
    },
    image: imageExpeditionaryForce,
  },
  {
    name: 'Project Hail Mary',
    author: 'Andy Weir',
    description:
      'A lone astronaut must save the earth from disaster in this incredible new science-based thriller. Without too many spoilers, the story is a must-read for sci-fi lovers.',
    link: {
      href: 'https://www.amazon.com/Project-Hail-Mary-Andy-Weir/dp/0593135202',
      label: 'Amazon',
    },
    image: imageProjectHailMary,
  },
  {
    name: 'Sapiens: A Brief History of Humankind',
    author: 'Yuval Noah Harari',
    description:
      "Sapiens is eye-opening and thought-provoking. The audiobook is also well narrated and definitely drew me in. Definitely a recommended for anyone interested in understanding humanity's context in history.",
    link: {
      href: 'https://www.audible.com/pd/Sapiens-Audiobook/B0741G911Q?source_code=ASSGB149080119000H&share_location=pdp',
      label: 'Audible',
    },
    image: imageSapiens,
  },
  {
    name: 'The Half-Life of Marie Curie',
    author: 'Lauren Gunderson',
    description:
      'The Half-Life of Marie Curie is a play about the friendship between Marie Curie and Hertha Ayrton, a brilliant British suffragette and inventor. The play is a great way to learn about the lives of these two amazing women who defied norms and made significant contributions to science.',
    link: {
      href: 'https://www.audible.com/pd/The-Half-Life-of-Marie-Curie-Audiobook/B07ZWP5WF6?source_code=ASSGB149080119000H&share_location=pdp',
      label: 'Audible',
    },
    image: imageHalfLifeOfMarieCurie,
  },
  {
    name: "Nexus", 
    author:"Yuval Noah Harari", 
    description: "Nexus explores the relationship between humanity and information. I would argue,  Information Technology. Just as expected, Yuval Noah Harari didn't disappoint, masterfully weaving a thought-provoking story, exploring the future with information from the past.", 
    link: {href: "https://www.audible.com/pd/Nexus-Audiobook/B0811111111?source_code=ASSGB149080119000H&share_location=pdp", label: "Audible"}, image: imageNexus
  },
]

function LinkIcon(props: React.ComponentPropsWithoutRef<'svg'>) {
  
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path
        d="M15.712 11.823a.75.75 0 1 0 1.06 1.06l-1.06-1.06Zm-4.95 1.768a.75.75 0 0 0 1.06-1.06l-1.06 1.06Zm-2.475-1.414a.75.75 0 1 0-1.06-1.06l1.06 1.06Zm4.95-1.768a.75.75 0 1 0-1.06 1.06l1.06-1.06Zm3.359.53-.884.884 1.06 1.06.885-.883-1.061-1.06Zm-4.95-2.12 1.414-1.415L12 6.344l-1.415 1.413 1.061 1.061Zm0 3.535a2.5 2.5 0 0 1 0-3.536l-1.06-1.06a4 4 0 0 0 0 5.656l1.06-1.06Zm4.95-4.95a2.5 2.5 0 0 1 0 3.535L17.656 12a4 4 0 0 0 0-5.657l-1.06 1.06Zm1.06-1.06a4 4 0 0 0-5.656 0l1.06 1.06a2.5 2.5 0 0 1 3.536 0l1.06-1.06Zm-7.07 7.07.176.177 1.06-1.06-.176-.177-1.06 1.06Zm-3.183-.353.884-.884-1.06-1.06-.884.883 1.06 1.06Zm4.95 2.121-1.414 1.414 1.06 1.06 1.415-1.413-1.06-1.061Zm0-3.536a2.5 2.5 0 0 1 0 3.536l1.06 1.06a4 4 0 0 0 0-5.656l-1.06 1.06Zm-4.95 4.95a2.5 2.5 0 0 1 0-3.535L6.344 12a4 4 0 0 0 0 5.656l1.06-1.06Zm-1.06 1.06a4 4 0 0 0 5.657 0l-1.061-1.06a2.5 2.5 0 0 1-3.535 0l-1.061 1.06Zm7.07-7.07-.176-.177-1.06 1.06.176.178 1.06-1.061Z"
        fill="currentColor"
      />
    </svg>
  )
}

export const metadata: Metadata = {
  title: 'Projects',
  description: 'Things I’ve made trying to put my dent in the universe.',
}

export default function Projects() {
  return (
    <SimpleLayout
      title="If I can see farther than others, it is because I stand on the shoulders of giants..."
      intro="Books, audiobooks, movies, and shows ignite my imagination. From the Expeditionary Force series to thought-provoking research papers, each story and idea opens new worlds of possibilities. Here are some of my favorites."
    >
      <ul
        role="list"
        className="grid grid-cols-1 gap-x-12 gap-y-16 sm:grid-cols-2 lg:grid-cols-4"
      >
        {books.map((book) => (
          <BookCard as="li" key={book.name}>
            <div className="z-10 flex h-28 w-full items-center justify-center rounded-md bg-white shadow-md shadow-zinc-800/5 ring-1 ring-zinc-900/5 dark:bg-zinc-800 dark:ring-0">
              <Image src={book.image} alt="" className="rounded-md" />
            </div>
            <h2 className="mt-6 text-base font-semibold text-zinc-800 dark:text-zinc-100">
              <BookCard.Link href={book.link.href}>
                {book.name} - <span className="italic">{book.author}</span>
              </BookCard.Link>
            </h2>
            <BookCard.Description>{book.description}</BookCard.Description>
            <p className="relative z-10 mt-6 flex text-sm font-medium text-zinc-400 transition group-hover:text-teal-500 dark:text-zinc-200">
              <LinkIcon className="h-6 w-6 flex-none" />
              <span className="ml-2">{book.link.label}</span>
            </p>
          </BookCard>
        ))}
      </ul>
    </SimpleLayout>
  )
}
