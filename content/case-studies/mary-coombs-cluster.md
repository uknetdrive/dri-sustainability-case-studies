---
title: "Mary Coombs Cluster: Architecture and Performance at STFC Hartree Centre"
description: "An overview of the Mary Coombs HPC cluster's GPU compute infrastructure, storage, scheduling and measured HPL performance, with potential directions for future energy-efficiency investigation."
roles:
  - hpc-facilitator
  - devops-engineer
tags:
  - hpc
  - gpu-computing
  - cluster-architecture
  - performance-benchmarking
  - resource-utilisation
author: "@Andrewsabre"
organisation: "STFC Hartree Centre"
date: 2026-11-04
draft: false
draftId: "e2e2befca9"
---

## Context

The Mary Coombs Cluster (MCC) is a High Performance Computing (HPC) system operated by the STFC Hartree Centre. The system provides GPU-accelerated computing resources to support computationally intensive workloads, with an architecture designed around high-performance compute nodes, high-speed networking and shared storage.

MCC uses NVIDIA H100 GPUs alongside Intel Xeon processors, providing the computational capabilities required for large-scale parallel workloads.

The cluster consists of several infrastructure components, including compute nodes, login nodes, data mover nodes, management nodes, load balancers, storage nodes and visualisation servers. These components work together to provide users with access to computing resources and the supporting services required to run their workloads.

This case study provides an overview of the cluster's architecture and performance, alongside considerations for future investigation into resource utilisation and energy efficiency.

## System Architecture

### Compute Infrastructure

The cluster's primary compute infrastructure consists of:

- **157 standard compute nodes**, each containing:
  - 4 × NVIDIA H100 GPUs
  - 2 × Intel Xeon Gold 6448Y 32-core 2.1 GHz processors
  - 512 GB DDR5 memory
  - Mellanox ConnectX NDR200 InfiniBand interconnect

- **10 high-memory compute nodes**, sharing the standard compute node specification but with 1.5 TB DDR5 memory per node.

The high-memory nodes provide additional capacity for workloads with greater memory requirements.

### Login and Data Transfer Infrastructure

MCC has a pool of 10 nodes that can be allocated between login and data mover roles depending on operational requirements.

Each node contains:

- 2 × Intel Xeon Gold 6448Y 32-core 2.1 GHz processors
- 512 GB DDR5 memory
- 1 × NVIDIA H100 GPU
- Mellanox ConnectX NDR200 InfiniBand interconnect

Login nodes provide users with an entry point to the cluster, while data mover nodes support the movement of data between systems.

The ability to adjust the distribution of these roles provides operational flexibility.

### Visualisation Infrastructure

The cluster includes 16 dedicated visualisation servers, each equipped with:

- 2 × Intel Xeon Gold 6448Y 32-core 2.1 GHz processors
- 512 GB DDR5 memory
- 1 × NVIDIA L40S GPU

These servers provide dedicated resources for visualisation workloads, separate from the primary compute infrastructure.

### Storage and Cluster Management

MCC provides **1.19 PB of usable scratch storage**, using the IBM Spectrum Scale (GPFS) parallel filesystem.

The cluster includes dedicated GPFS-related infrastructure to support access to the shared filesystem across nodes.

Additional management nodes and load balancers support the operation of the cluster and its services.

Workload scheduling is handled by **Slurm**, which manages the allocation of compute resources and execution of submitted jobs.

Together, these components provide the infrastructure required to support a multi-user HPC environment.

## System Performance

MCC has a theoretical peak GPU double-precision (FP64) performance of:

- **39 PFLOP/s** in turbo mode.
- **31 PFLOP/s** in nominal mode.

During High Performance LINPACK (HPL) benchmarking, the cluster consistently achieved approximately **24 PFLOP/s**.

This corresponds to:

- **77% efficiency** relative to the nominal theoretical peak.
- **61.5% efficiency** relative to the turbo theoretical peak.

The difference between theoretical and measured performance is expected in HPC systems, as theoretical peak figures represent idealised hardware capabilities rather than performance achievable under every workload.

These HPL results demonstrate the computational performance achieved by the cluster under benchmarking conditions. However, HPL efficiency should not be confused with energy efficiency, as the benchmark results alone do not provide information about power consumption.

## Sustainability and Future Considerations

Although this case study does not describe a specific energy-saving intervention, understanding the existing system architecture and performance provides a useful starting point for investigating opportunities to improve operational efficiency.

Potential areas for future investigation include:

- **Power monitoring:** Measuring power consumption at node and system level to understand energy usage under different workload conditions.
- **Resource utilisation:** Investigating CPU and GPU utilisation to identify underutilised resources and opportunities for more efficient scheduling.
- **Job scheduling:** Exploring whether Slurm configuration or scheduling policies could improve resource utilisation without adversely affecting user workloads.
- **Performance per watt:** Combining benchmark performance with measured power consumption to establish energy-efficiency baselines.

These represent possible future areas of investigation rather than changes currently implemented or measured on MCC.

## Lessons and Takeaways

The Mary Coombs Cluster demonstrates the infrastructure involved in operating a GPU-accelerated HPC environment, with dedicated resources for computation, data movement, visualisation and cluster management.

The system's HPL benchmarking results provide a useful baseline for understanding computational performance against theoretical hardware capabilities.

For future sustainability-focused work, establishing reliable power consumption and resource utilisation measurements would be an important first step. These measurements could help identify where changes might have a meaningful impact and provide the evidence needed to evaluate any improvements.

By documenting the existing architecture and performance, this case study establishes a starting point for future analysis of the cluster's operational and energy efficiency.
