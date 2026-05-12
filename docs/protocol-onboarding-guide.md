# Protocol Onboarding Guide (LLM Prompting)

This guide provides a high-fidelity prompt template that you can use with any LLM (GPT-4, Claude, etc.) to generate new protocol mappings for the OpenDDIL edge.

## 🏗 Why this works
OpenDDIL uses **Redpanda Connect** with hot-reloadable **Bloblang** mappings. Because the architecture is decoupled, you can use an LLM to "compile" any proprietary JSON schema into the OpenDDIL Protobuf format without showing the proprietary data to this primary agent.

## 📝 The Prompt Template
Copy and paste the section below into your target LLM.

---

### **[START PROMPT]**

**Role**: You are a Senior Data Engineer specializing in Redpanda Connect (formerly Benthos) and Bloblang.

**Objective**: Create a Redpanda Connect mapping resource that translates a proprietary simulation JSON format into the OpenDDIL Protobuf Telemetry v1 format.

**Constraints (MANDATORY)**:
1. **ADR-0007 (Unit Integrity)**: Do NOT perform any arithmetic or unit conversion (e.g., no F-to-C math). Map the raw value and attach the correct UCUM unit symbol (e.g., `[degF]`, `Cel`, `[kn_i]`, `m/s`).
2. **Schema Target**: The output must strictly follow the `openddil.telemetry.v1.EntityTelemetryEvent` protobuf structure.
3. **Pure Reshaping**: Focus on field selection, naming alignment, and type safety.
4. **Output Format**: Provide a standalone YAML file using the `processor_resources` pattern.

---

#### 1. Target Schema Context (OpenDDIL)
The destination is a nested Protobuf structure. Important paths include:
- `root.asset.asset_id`: String
- `root.kinematics.position.ecef`: {x_m, y_m, z_m}
- `root.sustainment.thermal.component_temperature`: {value, unit}
- `root.provenance.producer_id`: String (Identifying the simulator)

#### 2. Pattern Example (DIS-to-OpenDDIL)
Use this as your structural reference:
```yaml
processor_resources:
  - label: proprietary_mapping
    mapping: |
      let src = this
      root.event_id = uuid_v4()
      root.asset.asset_id = $src.id_field
      root.sustainment.thermal.component_temperature.value = $src.temp
      root.sustainment.thermal.component_temperature.unit  = "[degF]"
      root.provenance.ingest_time = now()
```

#### 3. Source Schema (Proprietary)
[PASTE YOUR PROPRIETARY JSON SCHEMA OR SAMPLE DATA HERE]

#### 4. Instruction
Generate the Bloblang mapping for the Source Schema provided in section 3. Ensure all kinematic, thermal, and power fields are mapped to their respective OpenDDIL paths with appropriate UCUM units.

### **[END PROMPT]**
