import { type Metadata } from 'next'
import Image from 'next/image'
import Link from 'next/link'
import clsx from 'clsx'

import { Container } from '@/components/Container'
import {
  GitHubIcon,
  InstagramIcon,
  LinkedInIcon,
  TwitterIcon,
} from '@/components/SocialIcons'
import portraitImage from '@/images/portrait.jpg'

function SocialLink({
  className,
  href,
  children,
  icon: Icon,
}: {
  className?: string
  href: string
  icon: React.ComponentType<{ className?: string }>
  children: React.ReactNode
}) {
  return (
    <li className={clsx(className, 'flex')}>
      <Link
        href={href}
        className="group flex text-sm font-medium text-zinc-800 transition hover:text-teal-500 dark:text-zinc-200 dark:hover:text-teal-500"
      >
        <Icon className="h-6 w-6 flex-none fill-zinc-500 transition group-hover:fill-teal-500" />
        <span className="ml-4">{children}</span>
      </Link>
    </li>
  )
}

function MailIcon(props: React.ComponentPropsWithoutRef<'svg'>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path
        fillRule="evenodd"
        d="M6 5a3 3 0 0 0-3 3v8a3 3 0 0 0 3 3h12a3 3 0 0 0 3-3V8a3 3 0 0 0-3-3H6Zm.245 2.187a.75.75 0 0 0-.99 1.126l6.25 5.5a.75.75 0 0 0 .99 0l6.25-5.5a.75.75 0 0 0-.99-1.126L12 12.251 6.245 7.187Z"
      />
    </svg>
  )
}

export const metadata: Metadata = {
  title: 'About',
  description:
    "Hi, I’m Frank Manu. I'm based in Greater Boston. I build comoplex systems.",
}

export default function About() {
  return (
    <Container className="mt-16 sm:mt-32">
      <div className="grid grid-cols-1 gap-y-16 lg:grid-cols-2 lg:grid-rows-[auto_1fr] lg:gap-y-12">
        <div className="lg:pl-20">
          <div className="max-w-xs px-2.5 lg:max-w-none">
            <Image
              src={portraitImage}
              alt=""
              sizes="(min-width: 1024px) 32rem, 20rem"
              className="aspect-square rotate-3 rounded-2xl bg-zinc-100 object-cover dark:bg-zinc-800"
            />
          </div>
        </div>
        <div className="lg:order-first lg:row-span-2">
          <h1 className="text-4xl font-bold tracking-tight text-zinc-800 dark:text-zinc-100 sm:text-5xl">
            Hi, I’m Frank Kofi Manu, based in Greater Boston. I build systems.
          </h1>
          <div className="mt-6 space-y-7 text-base text-zinc-600 dark:text-zinc-400">
            <p>
              <b>Call me Kofi</b>. I was born on a Friday and amongst my people
              Kofi is my soul name. I was gifted my first computer at age 11, a
              Compaq Pentium 1 computer. It had a floppy disk drive. I learned
              to type with Mavis Beacon Teaches Typing. That lady was strict.
              But, I really wanted Super Mario on my PC, so I had no choice but
              to type.
            </p>
            <p>
              I'm a trekkie. Kathryn Janeway of USS Voyager is my favorite
              captain. I always wanted to be a surgeon growing up, however, I
              will admit that my interests have always been varied. At age 14, I
              went to&nbsp;
              <a
                href="https://www.instagram.com/prempehcollege"
                className="font-semibold text-green-600 underline"
              >
                Prempeh College
              </a>
              , an all boys boarding school, where I studied General Science. I
              was on the debate team, served as a dorm prefect, and founded the
              local Robotics Team Chapter. There were lots of competitions and
              awards I helped win. I liked the glory of it all.
            </p>
            <p>
              I left Prempeh College in the final term of my senior year for
              America. I would soon realize that going to medical school after
              secondary/high school was not the norm here. Although, I had been
              studying for it, even if I passed the MCAT, I didn't have the
              required 4-year degree. I needed to pivot. I had always liked
              engineering too, but what field? I had my eyes on Mechanical but I
              tried Electrical and got hooked. I went further for an MSc. in
              Computer Engineering.
            </p>
            <p>
              Today, I work as a Systems Engineer. I love electrical and
              computer engineering, and I still keep up with my skills in that
              but I've always liked to explore. Discovering Systems Engineering
              was perfect. I've worked as a Systems Engineer ever since I got
              out of school.
            </p>
          </div>
        </div>
        <div className="lg:pl-20">
          <ul role="list">
            <SocialLink href="https://twitter.com/francman_" icon={TwitterIcon}>
              Follow on Twitter
            </SocialLink>
            <SocialLink
              href="https://www.instagram.com/francman_"
              icon={InstagramIcon}
              className="mt-4"
            >
              Follow on Instagram
            </SocialLink>
            <SocialLink
              href="https://github.com/francman"
              icon={GitHubIcon}
              className="mt-4"
            >
              Follow on GitHub
            </SocialLink>
            <SocialLink
              href="https://www.linkedin.com/in/frankmanu500/"
              icon={LinkedInIcon}
              className="mt-4"
            >
              Follow on LinkedIn
            </SocialLink>
            <SocialLink
              href="mailto:frankmanu500@gmail.com"
              icon={MailIcon}
              className="mt-8 border-t border-zinc-100 pt-8 dark:border-zinc-700/40"
            >
              frankmanu500@gmail.com
            </SocialLink>
          </ul>
        </div>
      </div>
    </Container>
  )
}
