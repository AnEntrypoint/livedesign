"use client"

import { useState } from "react"
import { Code2, Link, Mail, ExternalLink, ChevronRight, Menu, X } from "lucide-react"

import { Button } from "@/components/ui/button"

export default function Portfolio() {
  const [isMenuOpen, setIsMenuOpen] = useState(false)

  const projects = [
    {
      title: "E-Commerce Platform",
      description: "A full-stack e-commerce solution built with Next.js, TypeScript, and Stripe integration.",
      tags: ["Next.js", "TypeScript", "Stripe", "Tailwind CSS"],
      link: "#",
      github: "#"
    },
    {
      title: "Task Management App",
      description: "A collaborative task management application with real-time updates and team workspaces.",
      tags: ["React", "Node.js", "Socket.io", "PostgreSQL"],
      link: "#",
      github: "#"
    },
    {
      title: "AI Content Generator",
      description: "SaaS platform that leverages OpenAI API to generate marketing content for businesses.",
      tags: ["Vue.js", "Python", "FastAPI", "OpenAI"],
      link: "#",
      github: "#"
    }
  ]

  return (
    <div className="min-h-screen bg-background text-foreground font-sans">
      <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container mx-auto flex h-16 items-center justify-between px-4">
          <a href="#" className="text-2xl font-bold tracking-tight">
            Dev<span className="text-primary">Folio</span>
          </a>
          
          <nav className="hidden md:flex items-center gap-6 text-sm font-medium">
            <a href="#about" className="transition-colors hover:text-primary">About</a>
            <a href="#projects" className="transition-colors hover:text-primary">Projects</a>
            <a href="#contact" className="transition-colors hover:text-primary">Contact</a>
            <Button variant="outline" size="sm">Resume</Button>
          </nav>

          <button 
            className="md:hidden"
            onClick={() => setIsMenuOpen(!isMenuOpen)}
          >
            {isMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
          </button>
        </div>

        {isMenuOpen && (
          <nav className="md:hidden border-b bg-background p-4 flex flex-col gap-4">
            <a href="#about" className="block px-2 py-1 text-sm font-medium hover:text-primary" onClick={() => setIsMenuOpen(false)}>About</a>
            <a href="#projects" className="block px-2 py-1 text-sm font-medium hover:text-primary" onClick={() => setIsMenuOpen(false)}>Projects</a>
            <a href="#contact" className="block px-2 py-1 text-sm font-medium hover:text-primary" onClick={() => setIsMenuOpen(false)}>Contact</a>
            <Button variant="outline" className="w-full">Resume</Button>
          </nav>
        )}
      </header>

      <main className="container mx-auto px-4 py-12 md:py-24 flex flex-col gap-24">
        <section id="about" className="flex flex-col items-start gap-6 max-w-3xl">
          <div className="inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80">
            Available for work
          </div>
          <h1 className="text-4xl md:text-6xl font-bold tracking-tight">
            Building digital experiences that matter.
          </h1>
          <p className="text-xl text-muted-foreground leading-relaxed">
            I'm a Full-Stack Developer specializing in building exceptional web applications. 
            I focus on writing clean, scalable, and efficient code.
          </p>
          <div className="flex gap-4">
            <Button variant="default">Contact Me</Button>
            <Button variant="ghost" className="gap-2">
              View Work <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
          <div className="flex gap-4 mt-4">
            <a href="#" className="text-muted-foreground hover:text-foreground transition-colors">
              <Code2 className="w-6 h-6" />
            </a>
            <a href="#" className="text-muted-foreground hover:text-foreground transition-colors">
              <Link className="w-6 h-6" />
            </a>
            <a href="#" className="text-muted-foreground hover:text-foreground transition-colors">
              <Mail className="w-6 h-6" />
            </a>
          </div>
        </section>

        <section id="projects" className="flex flex-col gap-12">
          <div>
            <h2 className="text-3xl font-bold tracking-tight">Featured Projects</h2>
            <p className="text-muted-foreground mt-2">A selection of my recent work.</p>
          </div>
          
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {projects.map((project, index) => (
              <div key={index} className="rounded-xl border bg-card text-card-foreground shadow flex flex-col overflow-hidden transition-all hover:shadow-lg">
                <div className="flex flex-col space-y-1.5 p-6 pb-2">
                  <h3 className="font-semibold leading-none tracking-tight text-xl">{project.title}</h3>
                  <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
                    {project.description}
                  </p>
                </div>
                <div className="p-6 pt-2 flex-grow">
                  <div className="flex flex-wrap gap-2">
                    {project.tags.map((tag) => (
                      <span key={tag} className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80">
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="flex items-center p-6 border-t bg-secondary/20 justify-between mt-auto">
                  <Button variant="ghost" size="sm" className="gap-2">
                    <Code2 className="w-4 h-4" /> Code
                  </Button>
                  <Button variant="default" size="sm" className="gap-2">
                    <ExternalLink className="w-4 h-4" /> Live Demo
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section id="contact" className="border rounded-2xl bg-secondary/10 p-8 md:p-16 flex flex-col items-center text-center gap-6 max-w-4xl mx-auto w-full">
          <h2 className="text-3xl md:text-4xl font-bold tracking-tight">Let's work together.</h2>
          <p className="text-xl text-muted-foreground max-w-2xl">
            I'm currently open to new opportunities and freelance projects. 
            Have a project in mind? Let's discuss how we can bring it to life.
          </p>
          <Button size="lg" className="gap-2 mt-4">
            <Mail className="w-5 h-5" /> Get In Touch
          </Button>
        </section>
      </main>

      <footer className="border-t py-8 mt-12 text-center text-sm text-muted-foreground">
        <div className="container mx-auto px-4">
          <p>© {new Date().getFullYear()} DevFolio. Built with Next.js & Tailwind CSS.</p>
        </div>
      </footer>
    </div>
  )
}
