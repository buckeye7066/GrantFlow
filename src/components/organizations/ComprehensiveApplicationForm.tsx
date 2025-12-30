import { Fragment } from "react"
import { Controller, useFormContext } from "react-hook-form"
import { Input } from "../ui/input"
import { Textarea } from "../ui/textarea"
import { Checkbox } from "../ui/checkbox"
import { Select } from "../ui/select"
import type { ProfileFormValues } from "./ProfileForm"
import { APPLICATION_SECTIONS } from "./applicationSections"

function isArrayValue(value: unknown): value is string[] {
  return Array.isArray(value)
}

export function ComprehensiveApplicationForm() {
  const { control } = useFormContext<ProfileFormValues>()

  return (
    <section className="space-y-6">
      <header className="space-y-2">
        <h2 className="text-lg font-semibold text-foreground">Comprehensive Application Addendum</h2>
        <p className="text-sm text-muted-foreground">
          Capture the extended data set required by the Comprehensive Profile Application. All fields are saved in the
          profile&rsquo;s <code>application_data</code> payload.
        </p>
      </header>

      {APPLICATION_SECTIONS.map((section) => (
        <div key={section.id} className="space-y-4 rounded-lg border border-border/60 bg-muted/10 p-4">
          <div className="space-y-1">
            <h3 className="text-base font-semibold text-foreground">{section.title}</h3>
            {section.description ? <p className="text-sm text-muted-foreground">{section.description}</p> : null}
          </div>
          <div
            className={
              section.layout === "grid"
                ? "grid gap-4 md:grid-cols-2"
                : "flex flex-col gap-4"
            }
          >
            {section.fields.map((field) => (
              <Controller
                key={field.id}
                control={control}
                name={`application_data.${field.id}`}
                render={({ field: controllerField }) => {
                  const commonLabel = (
                    <span className="text-sm font-medium text-foreground">
                      {field.label}
                      {field.description ? (
                        <span className="block text-xs font-normal text-muted-foreground">{field.description}</span>
                      ) : null}
                    </span>
                  )

                  const wrapperClass =
                    section.layout === "grid" && field.width !== "full"
                      ? "space-y-2"
                      : "space-y-2 md:col-span-2"

                  switch (field.type) {
                    case "text":
                      return (
                        <label className={wrapperClass}>
                          {commonLabel}
                          <Input
                            value={typeof controllerField.value === "string" ? controllerField.value : ""}
                            onChange={(event) => controllerField.onChange(event.target.value)}
                            onBlur={controllerField.onBlur}
                            placeholder={field.placeholder}
                          />
                        </label>
                      )
                    case "textarea":
                      return (
                        <label className={wrapperClass}>
                          {commonLabel}
                          <Textarea
                            rows={4}
                            value={typeof controllerField.value === "string" ? controllerField.value : ""}
                            onChange={(event) => controllerField.onChange(event.target.value)}
                            onBlur={controllerField.onBlur}
                            placeholder={field.placeholder}
                          />
                        </label>
                      )
                    case "date":
                      return (
                        <label className={wrapperClass}>
                          {commonLabel}
                          <Input
                            type="date"
                            value={typeof controllerField.value === "string" ? controllerField.value : ""}
                            onChange={(event) => controllerField.onChange(event.target.value)}
                            onBlur={controllerField.onBlur}
                          />
                        </label>
                      )
                    case "number":
                      return (
                        <label className={wrapperClass}>
                          {commonLabel}
                          <Input
                            type="number"
                            value={
                              typeof controllerField.value === "number"
                                ? controllerField.value.toString()
                                : typeof controllerField.value === "string"
                                  ? controllerField.value
                                  : ""
                            }
                            onChange={(event) => controllerField.onChange(event.target.value)}
                            onBlur={controllerField.onBlur}
                          />
                        </label>
                      )
                    case "boolean":
                      return (
                        <label className="flex items-center gap-3 text-sm md:col-span-2">
                          <Checkbox
                            checked={Boolean(controllerField.value)}
                            onChange={(event) => controllerField.onChange(event.target.checked)}
                            onBlur={controllerField.onBlur}
                          />
                          <span className="text-sm text-foreground">{field.label}</span>
                        </label>
                      )
                    case "single-select":
                      return (
                        <label className={wrapperClass}>
                          {commonLabel}
                          <Select
                            value={typeof controllerField.value === "string" ? controllerField.value : ""}
                            onChange={(event) => controllerField.onChange(event.target.value)}
                            onBlur={controllerField.onBlur}
                          >
                            <option value="">Select an option</option>
                            {(field.options ?? []).map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </Select>
                        </label>
                      )
                    case "multi-select": {
                      const selected = isArrayValue(controllerField.value) ? controllerField.value : []
                      return (
                        <div className="space-y-3 md:col-span-2">
                          <span className="text-sm font-medium text-foreground">{field.label}</span>
                          <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
                            {(field.options ?? []).map((option) => {
                              const checked = selected.includes(option.value)
                              return (
                                <label
                                  key={option.value}
                                  className="flex items-center gap-3 rounded-md border border-border/60 bg-background px-3 py-2 text-sm"
                                >
                                  <Checkbox
                                    checked={checked}
                                    onChange={() => {
                                      const next = checked
                                        ? selected.filter((value) => value !== option.value)
                                        : [...selected, option.value]
                                      controllerField.onChange(next)
                                    }}
                                    onBlur={controllerField.onBlur}
                                  />
                                  <span className="text-sm text-foreground">{option.label}</span>
                                </label>
                              )
                            })}
                          </div>
                        </div>
                      )
                    }
                    default:
                      return <Fragment key={field.id} />
                  }
                }}
              />
            ))}
          </div>
        </div>
      ))}
    </section>
  )
}
